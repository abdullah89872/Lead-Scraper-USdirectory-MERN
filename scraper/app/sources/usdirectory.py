"""USdirectory.com source.

Public data only. The source builds the directory's public listing URLs, walks
the pagination it advertises, and reads the business details that the page
publishes (JSON-LD first, then visible markup).

Compliance notes (see docs/SCRAPING_POLICY.md):

* ``robots.txt`` is honoured before every request.
* Requests are serialised per host with a configurable delay and capped
  concurrency; retries use exponential backoff.
* If the site answers with 401/403/429/451, a CAPTCHA/anti-bot challenge or a
  geo/IP restriction notice, the run **stops** and reports the restriction.
  Nothing is bypassed, spoofed or worked around.
"""

from __future__ import annotations

import logging
import re
from typing import Any
from urllib.parse import quote, urlparse

from ..extractors.contact import (
    extract_address_node,
    extract_contact_points,
    extract_postal_from_text,
    extract_services,
    extract_website,
    first_text,
)
from ..extractors.html import (
    LOCAL_BUSINESS_TYPES,
    absolute,
    canonical_url,
    clean_text,
    extract_json_ld_contact,
    find_anchors,
    find_next_page_url,
    json_ld_blocks,
    make_soup,
    pick_local_business,
)
from ..models import Lead
from ..services.us_states import LocationError, parse_location, state_abbr
from ..validators.emails import extract_emails, normalize_email
from ..validators.phones import extract_phones, normalize_phone
from .base import DirectorySource, ProfileRef, SearchPage

logger = logging.getLogger(__name__)

# Paths that are never business profiles.
RESERVED_PATHS = {
    "", "search", "login", "register", "signin", "signup", "about", "contact",
    "terms", "privacy", "blog", "help", "sitemap", "advertise", "category",
    "categories", "states", "cities", "directory", "api", "account",
}

# USdirectory business profile slugs, verified live against the site sitemap and
# live pages:
#   /M-J-Pool-Services-Houston-TX
#   /Jensen-Private-Investigations-Salt-Lake-City-UT
#   /Lucy-s-Spotless-Cleaning-Boise-ID-1      <- trailing number is OPTIONAL
#
# The old pattern required a trailing "-\d+", so it matched none of the real URLs
# (most have no number). That trailing number is only a duplicate disambiguator
# (e.g. the 2nd "-Boise-ID" listing), never a stable record id.
TRAILING_DISAMBIGUATOR_RE = re.compile(r"-(\d+)$")

# The site serves TWO different profile URL shapes, and both are live:
#
#   1. Modern SEO slug (pages 1-2 of a listing):
#        /M-J-Pool-Services-Houston-TX
#        /Lucy-s-Spotless-Cleaning-Boise-ID-1     <- trailing number OPTIONAL
#      The trailing number is only a duplicate disambiguator, never a record id.
#
#   2. Legacy ASP.NET profile (most of pages 3+):
#        /b/352529/Professional-cleaning-Miami-Florida.aspx
#      Verified live: returns HTTP 200 with its own self-referencing canonical
#      URL. These used to be dropped because they do not end in a state code,
#      which silently truncated every crawl at page 2 (the site has 6+ pages).
LEGACY_PROFILE_RE = re.compile(r"^b/(\d+)/[^/]+\.aspx$", re.IGNORECASE)

# Site pages that are never businesses (verified live).
EXTRA_RESERVED_SLUGS = frozenset(
    {
        "about-us", "contact-us", "password-recovery", "find-a-business",
        "how-it-works", "products-and-services", "get-started", "articles",
        "faq", "for-merchants", "frontdesk-ai", "boost-my-business",
        "profile-boost-pro",
    }
)

# Two-digit tokens that only *look* like US state codes but are not states.
# ``/Cal-Sons-Carpet-and-Wood-Flooring-Miami`` ends in "Miami", and the site
# also uses tokens such as "Lp" for "El Paso"; treating any two letters as a
# state produced false positives, so the list below is the real one.
PSEUDO_STATE_TOKENS = frozenset({"LP", "OF", "TO", "IN", "IS", "IT", "ON", "AT", "BY", "NO"})


def legacy_profile_id(path: str) -> str | None:
    """Return the numeric business id for a legacy ``/b/{id}/{slug}.aspx`` path.

    These URLs are the majority of listings past page 2. Verified live: they
    return HTTP 200 with a self-referencing canonical URL, so they are real
    public profile pages and must be collected like any other.
    """
    match = LEGACY_PROFILE_RE.match((path or "").strip("/"))
    return f"b{match.group(1)}" if match else None


# The site paginates with a plain ``?page=N``. Both the bracketed search form
# (``search[page]=2``) and the simple form are accepted so the helper works for
# every listing shape the site serves.
PAGE_PARAM_PATTERNS = (
    re.compile(r"[?&]page=(\d+)"),
    re.compile(r"search(?:%5D|\[)page(?:%5D|\[)=(\d+)"),
)


def _page_number(url: str) -> int | None:
    """Return the 1-based page number encoded in ``url`` (None when absent)."""
    for pattern in PAGE_PARAM_PATTERNS:
        match = pattern.search(url or "")
        if match:
            return int(match.group(1))
    return None


def _with_page(url: str, page: int) -> str:
    """Return ``url`` with its page parameter set to ``page``."""
    for pattern in PAGE_PARAM_PATTERNS:
        updated, count = pattern.subn(
            lambda match: f"{match.group(0).rsplit('=', 1)[0]}={page}", url or ""
        )
        if count:
            return updated
    separator = "&" if "?" in (url or "") else "?"
    return f"{url}{separator}page={page}"


def profile_state_token(slug: str) -> str | None:
    """Return the state abbreviation if ``slug`` has a business-profile shape.

    Accepts both live shapes:

    * ``M-J-Pool-Services-Houston-TX`` (modern slug, optional trailing ``-N``
      duplicate disambiguator)
    * ``b/352529/Professional-cleaning-Miami-Florida.aspx`` (legacy profile)

    Returns ``None`` for ordinary site pages and reserved paths.
    """
    slug = (slug or "").strip("/")
    if not slug:
        return None
    if legacy_profile_id(slug):
        return "US"  # legacy URLs encode city/state in the slug, not a code
    if "/" in slug:
        return None
    if slug.lower() in EXTRA_RESERVED_SLUGS:
        return None
    stem = TRAILING_DISAMBIGUATOR_RE.sub("", slug)
    head, sep, tail = stem.rpartition("-")
    if not sep or not head:
        return None
    token = tail.upper()
    if token in PSEUDO_STATE_TOKENS:
        return None
    return token if token in SITE_STATE_CODES else None

BUSINESS_TYPE_LABELS = {
    "roofingcontractor": "Roofing Contractor",
    "generalcontractor": "General Contractor",
    "homeandconstructionbusiness": "Home & Construction",
    "professionalservice": "Professional Services",
    "localbusiness": "Local Business",
    "organization": "Business",
    "store": "Retail",
    "plumber": "Plumber",
    "electrician": "Electrician",
    "movingcompany": "Moving Company",
    "autorepair": "Auto Repair",
}

# Selector knowledge is centralised in ``app.sources.selectors`` so a future
# redesign of the directory's markup is fixed in one place.
from .selectors import (  # noqa: E402  (import kept next to its former definitions)
    ADDRESS_SELECTORS,
    BREADCRUMB_SELECTORS,
    DESCRIPTION_SELECTORS,
    LISTING_CARD_SELECTORS,
    NAME_SELECTORS,
    PAGE_LINK_SELECTORS,
)

# Every anchor inside a pagination block, whatever the site calls it.
PAGE_LINK_QUERY = (
    ",".join(f"{selector} a" for selector in PAGE_LINK_SELECTORS)
    + ",.pagination a,.pager a,[class*='pagination'] a"
)

# Valid US state / territory abbreviations.
#
# Profile slugs end in "-<STATE>" (e.g. /M-J-Pool-Services-Houston-TX). Without
# this check, ordinary site pages whose last token happens to be two letters are
# indistinguishable from a profile - live examples that used to be mis-detected:
#   /About-Us, /Contact-Us, /Password-Recovery
SITE_STATE_CODES = frozenset(
    "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO "
    "MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY "
    "DC PR VI GU AS MP".split()
)

# The site publishes a fixed category taxonomy per city (verified live on
# /Texas/Frisco: Animals-Pets, Appliance-Electronics, Arts-Entertainment,
# Automotive, Auto-Repair, Beauty-Salons, Beauty-Wellness, Business-Services,
# Cannabis-Related, Cleaning-Services, Contractors, Finance-Insurance,
# Food-Beverage, Health-Medicine, Home-Services, HVAC-Services, Information,
# Legal, Manufacturing, Other, Personal-Services-Care, Professional-Services,
# Real-Estate, Remodeling-and-Repair, Shopping-Retail-Lifestyle,
# Sports-Recreation, Transportation, Tree-Services).
#
# A user's trade ("Plumbing") is usually NOT a taxonomy slug - that is why the
# old fixed /State/City/Category guess returned HTTP 410. These synonyms are only
# used after checking the city's real category list, so a stale entry can never
# send us to a page that does not exist.
#
# Some trades are spread across several of the site's top-level categories, so
# each trade maps to an *ordered* list and every category the city really
# publishes is crawled. Verified live on 2026-04-10:
#   /Oregon/Hillsboro/Roofing        -> 410 (there is no such category)
#   /Oregon/Hillsboro/Roofing-Services -> 200
#   /Oregon/Hillsboro/Contractors    -> 200
#   /Oregon/Hillsboro/Home-Services  -> 200
CATEGORY_SYNONYMS: dict[str, list[str]] = {
    "plumbing": ["Home-Services", "Contractors"],
    "plumber": ["Home-Services", "Contractors"],
    "roofing": ["Roofing-Services", "Contractors", "Home-Services", "Remodeling-and-Repair"],
    "roofer": ["Roofing-Services", "Contractors", "Home-Services", "Remodeling-and-Repair"],
    "roofing services": ["Roofing-Services", "Contractors", "Home-Services", "Remodeling-and-Repair"],
    "siding": ["Home-Services", "Contractors", "Remodeling-and-Repair"],
    "painting": ["Home-Services", "Contractors", "Remodeling-and-Repair"],
    "contractor": ["Contractors"],
    "general contractor": ["Contractors"],
    "remodeling": ["Remodeling-and-Repair", "Contractors"],
    "repair": ["Remodeling-and-Repair", "Contractors"],
    "hvac": ["HVAC-Services", "Home-Services", "Contractors"],
    "air conditioning": ["HVAC-Services", "Home-Services", "Contractors"],
    "heating": ["HVAC-Services", "Home-Services", "Contractors"],
    "landscaping": ["Tree-Services", "Home-Services", "Contractors"],
    "lawn care": ["Tree-Services", "Home-Services", "Contractors"],
    "tree service": ["Tree-Services", "Home-Services", "Contractors"],
    "electrician": ["Home-Services", "Electrical-Services", "Contractors"],
    "electrical": ["Home-Services", "Electrical-Services", "Contractors"],
    "cleaning": ["Cleaning-Services", "Home-Services"],
    "janitorial": ["Cleaning-Services", "Home-Services"],
    "auto repair": ["Auto-Repair", "Automotive"],
    "automotive": ["Automotive"],
    "restaurant": ["Food-Beverage"],
    "beauty salon": ["Beauty-Salons"],
    "hair salon": ["Beauty-Salons"],
    "barber": ["Beauty-Salons"],
    "law firm": ["Legal"],
    "attorney": ["Legal"],
    "dentist": ["Health-Medicine"],
    "doctor": ["Health-Medicine"],
    "veterinarian": ["Animals-Pets"],
    "pet": ["Animals-Pets"],
    "real estate": ["Real-Estate"],
    "accountant": "Finance-Insurance",
    "bank": "Finance-Insurance",
    "insurance": "Finance-Insurance",
    "florist": "Shopping-Retail-Lifestyle",
    "gym": "Sports-Recreation",
    "salon": "Beauty-Salons",
}


class USDirectorySource(DirectorySource):
    name = "usdirectory"
    display_name = "USdirectory.com"

    def __init__(self, *, base_url: str = "https://usdirectory.com", search_template: str = ""):
        self.base_url = base_url.rstrip("/")
        self.search_template = (search_template or "").strip()
        # Filled in by prepare(): the category slugs this city really publishes.
        self.city_categories: list[str] = []

    # ------------------------------------------------------------------ URLs
    @staticmethod
    def slugify(value: str) -> str:
        """'business services' -> 'Business-Services', 'roofing' -> 'Roofing'."""
        words = re.split(r"[\s_/&,]+", (value or "").strip())
        cleaned = [re.sub(r"[^A-Za-z0-9\-']", "", word) for word in words if word]
        return "-".join(word[:1].upper() + word[1:] for word in cleaned if word)

    def search_urls(self, category: str, location: str) -> list[str]:
        if not (category or "").strip():
            raise LocationError("category is required to build a search URL")

        if self.search_template:
            head, _, tail = location.partition(",")
            return [
                self.search_template.format(
                    category=self.slugify(category),
                    city=self.slugify(head),
                    state=self.slugify(tail or location),
                    state_abbr=state_abbr(tail or location) or "",
                    page=1,
                )
            ]

        parts = parse_location(location)
        state_slug = self.slugify(parts.state_name or "")

        # Resolve the trade onto the slug(s) this city actually publishes.
        # Guessing produced HTTP 410 (site Error404 redirect) in live testing.
        resolved = self.resolve_categories(category)

        if parts.city and resolved:
            city_slug = self.slugify(parts.city)
            urls = [f"{self.base_url}/{state_slug}/{city_slug}/{slug}" for slug in resolved]
            logger.info(
                "category %r resolved to %s for %s/%s",
                category, resolved, state_slug, city_slug,
            )
            return urls

        if not parts.city and resolved:
            # State-wide listing, no city segment.
            return [f"{self.base_url}/{state_slug}/{slug}" for slug in resolved]

        # Last resort: the site's own text search form
        # (action="/", fields search[query] + searchLocation).
        query = quote((category or "").strip(), safe="")
        place = quote((location or "").strip(), safe="")
        search_url = f"{self.base_url}/?search%5Bquery%5D={query}&searchLocation={place}"
        logger.info(
            "no verified category slug for %r; falling back to text search", category
        )
        return [search_url]

    def is_profile_url(self, url: str) -> bool:
        parsed = urlparse(url)
        if self.host and self.host not in (parsed.netloc or "").lower():
            return False
        path = parsed.path or "/"
        if path.strip("/").lower() in RESERVED_PATHS:
            return False
        # Accepts both the modern "-ST" slug and the legacy "/b/{id}/x.aspx".
        return profile_state_token(path) is not None

    def extract_source_id(self, url: str) -> str | None:
        """Stable identity for a profile.

        For modern slugs the slug itself is the identity; the optional trailing
        "-<n>" is only a duplicate disambiguator, so it is kept as part of the
        slug rather than treated as a record id. For legacy ``/b/{id}/...``
        profiles the numeric id is the real record id and is preferred, because
        the same business can appear under both shapes.

        Non-profile URLs (listing/category pages) return ``None``.
        """
        slug = (urlparse(url).path or "").strip("/")
        if not slug or profile_state_token(slug) is None:
            return None
        legacy_id = legacy_profile_id(slug)
        if legacy_id:
            return legacy_id
        if "/" in slug:
            return None
        return slug

    # ------------------------------------------------------- category lookup
    async def prepare(
        self,
        fetcher: Any,
        *,
        category: str,
        location: str,
        max_leads: int,
        enrichment: bool = True,
    ) -> None:
        """Learn the city's real category slugs so the listing URL exists.

        Verified live: ``/Texas/Frisco`` (HTTP 200) publishes the taxonomy, while
        a guessed slug such as ``/Texas/Frisco/Plumbing`` returns HTTP 410 via the
        site's Error404 redirect. We therefore read the categories the city
        actually publishes and match the requested trade against those.
        """
        self.city_categories = []
        try:
            parts = parse_location(location)
        except LocationError:
            return
        if not parts.city:
            return

        state_slug = self.slugify(parts.state_name or "")
        city_slug = self.slugify(parts.city)
        if not state_slug or not city_slug:
            return

        city_url = f"{self.base_url}/{state_slug}/{city_slug}"
        response = await fetcher.get(city_url)
        if not response.ok or not response.text:
            logger.info("city category list unavailable for %s", city_url)
            return

        soup = make_soup(response.text)
        found: list[str] = []
        for anchor in soup.find_all("a", href=True):
            href = str(anchor["href"])
            prefix = f"/{state_slug}/{city_slug}/"
            if not href.startswith(prefix):
                continue
            tail = href[len(prefix):].strip("/")
            # A category segment has no further "/" and is not a profile slug.
            if tail and "/" not in tail and profile_state_token(tail) is None:
                if tail not in found:
                    found.append(tail)
        self.city_categories = found
        logger.info("city %s publishes %d categories", city_url, len(found))

    def resolve_categories(self, category: str) -> list[str]:
        """Map free text onto the site slugs that really hold this trade.

        Verified live: a guessed slug (``/Oregon/Hillsboro/Roofing``) returns
        HTTP 410, while the categories the city actually publishes return 200.
        So when the city's published list is known (``prepare`` ran) the trade is
        matched against it and every plausible category is returned, best first.

        When the taxonomy is *not* known we return a single candidate - the
        caller's own slug - so behaviour stays predictable instead of guessing.
        """
        raw = (category or "").strip()
        if not raw:
            return []
        available = self.city_categories or []
        wanted = raw.lower()

        if not available:
            return [self.slugify(raw)]

        # 1) exact slug match (case-insensitive)
        for slug in available:
            if slug.lower() == wanted:
                return [slug]

        # 2) the trade's known category slugs, but only the ones this city has
        synonyms = CATEGORY_SYNONYMS.get(wanted, [])
        by_lower = {slug.lower(): slug for slug in available}
        ranked = [by_lower[s.lower()] for s in synonyms if s.lower() in by_lower]

        # 3) token overlap against the published slugs
        tokens = {t for t in re.split(r"[^a-z0-9]+", wanted) if len(t) > 2}
        if tokens:
            scored: list[tuple[int, str]] = []
            for slug in available:
                slug_tokens = {
                    t for t in re.split(r"[^a-z0-9]+", slug.lower()) if len(t) > 2
                }
                score = len(tokens & slug_tokens)
                if score:
                    scored.append((score, slug))
            # Stable ordering: strongest match first, then the site's order.
            scored.sort(key=lambda pair: (-pair[0], available.index(pair[1])))
            ranked.extend(slug for _score, slug in scored)

        # Preserve order while dropping duplicates.
        seen: set[str] = set()
        unique: list[str] = []
        for slug in ranked:
            if slug not in seen:
                seen.add(slug)
                unique.append(slug)
        return unique

    def resolve_category(self, category: str) -> str | None:
        """Best single category slug for ``category`` (see resolve_categories)."""
        ranked = self.resolve_categories(category)
        return ranked[0] if ranked else None

    # --------------------------------------------------------------- listing
    def parse_search_page(self, html: str, url: str) -> SearchPage:
        soup = make_soup(html)
        page = SearchPage()

        # 1) Card containers first: they are the site's own listing markup
        #    (div.city-business-row) and, unlike a bare anchor, they also carry
        #    the business name, so leads are not returned nameless.
        by_url: dict[str, ProfileRef] = {}
        for card in soup.select(", ".join(LISTING_CARD_SELECTORS)):
            anchor = card.find("a", href=True)
            if not anchor:
                continue
            target = absolute(str(anchor["href"]), url)
            if not self.is_profile_url(target):
                continue
            heading = card.find(["h2", "h3", "h4"])
            name = first_text(heading) or first_text(anchor)
            if not name:
                image = card.find("img", attrs={"alt": True})
                name = clean_text(image.get("alt")) if image else None
            existing = by_url.get(target)
            if existing is None:
                by_url[target] = ProfileRef(
                    url=target,
                    source_id=self.extract_source_id(target),
                    business_name=name,
                )
            elif existing.business_name is None and name:
                existing.business_name = name

        # 2) Any remaining profile anchors (including ones outside a card, and
        #    the JSON-LD ItemList the site publishes for each listing).
        for target in find_anchors(
            soup, url, lambda candidate, _anchor: self.is_profile_url(candidate)
        ):
            by_url.setdefault(
                target,
                ProfileRef(url=target, source_id=self.extract_source_id(target)),
            )

        for node in self._json_ld_listings(soup):
            target = node.get("url") or node.get("id")
            if not target:
                continue
            target = absolute(str(target), url)
            if not self.is_profile_url(target):
                continue
            ref = by_url.get(target)
            if ref is None:
                by_url[target] = ProfileRef(
                    url=target,
                    source_id=self.extract_source_id(target),
                    business_name=clean_text(node.get("name")),
                )
            elif ref.business_name is None:
                ref.business_name = clean_text(node.get("name"))

        page.refs = list(by_url.values())

        # ``_guess_next_page`` owns the whole decision (rel=next, the pager's own
        # numbering, then bounded ?page=N+1 arithmetic). Calling the generic
        # ``find_next_page_url`` first used to return the *current* page whenever
        # the pager rendered bare numbers, which stalled pagination at page 1.
        page.next_url = self._guess_next_page(soup, url) if page.refs else None
        return page

    @staticmethod
    def _json_ld_listings(soup: Any) -> list[dict[str, Any]]:
        """Business nodes from the page's JSON-LD ``ItemList``.

        The listing page publishes every result as schema.org ``LocalBusiness``
        inside an ``ItemList`` (``numberOfItems`` = total for the whole
        listing). This is first-party structured data, so it outranks scraping
        the card markup and gives us names even when a card renders oddly.
        """
        listings: list[dict[str, Any]] = []
        for node in json_ld_blocks(soup):
            types = node.get("@type") or node.get("type")
            names = {str(t).lower() for t in types} if isinstance(types, list) else {str(types).lower()}
            if "itemlist" in names:
                for entry in node.get("itemListElement") or []:
                    inner = entry.get("item") if isinstance(entry, dict) else None
                    if isinstance(inner, dict):
                        listings.append(inner)
            elif names & LOCAL_BUSINESS_TYPES and (node.get("url") or node.get("id")):
                listings.append(node)
        return listings

    def _guess_next_page(self, soup: Any, url: str) -> str | None:
        """Resolve the next listing page for this directory.

        Resolution order:

        1. ``rel="next"`` (the standards-compliant signal).
        2. The pager's own "next" control (text/aria-label based).
        3. The page number that follows the current one in the pager markup.
        4. ``?page=N+1`` arithmetic, but only when the current URL already
           carries a page number - and never to a number the pager does not
           advertise, so we cannot walk past the end of the listing.

        Verified live: the site's pager renders bare page numbers plus an
        arrow whose label is empty, so step 3 is what actually drives the crawl.
        """
        current = _page_number(url)

        # (1) and (2): an explicit "next" link wins.
        explicit = find_next_page_url(soup, url)
        if explicit and _page_number(explicit) != current:
            return explicit

        # (3): follow the pager's own numbering.
        pager_numbers = sorted({
            number
            for number in (
                _page_number(str(anchor["href"]))
                for anchor in soup.select(PAGE_LINK_QUERY)
                if anchor.get("href")
            )
            if number is not None
        })
        following = [n for n in pager_numbers if current is None or n > current]
        if following:
            return _with_page(url, following[0])

        # (4) only guess when the site already paginates this URL, and only up to
        # the highest page the pager advertises (otherwise we are done).
        if current is None:
            return None
        if pager_numbers and current + 1 > pager_numbers[-1]:
            return None
        return _with_page(url, current + 1)

    # --------------------------------------------------------------- profile
    def parse_profile(
        self,
        html: str,
        url: str,
        *,
        category: str | None = None,
        location: str | None = None,
    ) -> Lead | None:
        soup = make_soup(html)
        self._current_url = canonical_url(url)
        blocks = json_ld_blocks(soup)
        node = pick_local_business(blocks) or {}

        name = clean_text(node.get("name")) or self._first_selector(soup, NAME_SELECTORS)
        if not name:
            return None

        address_info = self._address(soup, node, url)
        # Scoped to this business: the page also lists other companies whose
        # contacts must not be attributed to this record.
        contacts = self._contacts_for(soup, node, blocks)
        emails = list(contacts["emails"])
        phones = list(contacts["phones"])

        # Regex over visible text is only used when no explicit contact block
        # exists, and it can only surface values already displayed on the page.
        if not emails or not phones:
            text = soup.get_text(" ", strip=True)
            if not emails:
                emails = extract_emails(text)
            if not phones:
                phones = extract_phones(text)

        emails = _dedupe([addr for addr in (normalize_email(e) for e in emails) if addr])
        phones = _dedupe([num for num in (normalize_phone(p) for p in phones) if num])

        # The directory publishes its own support/contact details in the page
        # footer. Those belong to USdirectory, not to the business, so they are
        # never stored on a lead (verified live: a page yielded
        # support@usdirectory.com).
        emails = [e for e in emails if not self._is_directory_email(e)]

        # JSON-LD "url" on a directory profile points at the profile itself
        # (https://usdirectory.com/<slug>), which is not the business' website.
        # Only an off-directory URL counts as a real website.
        website = None
        ld_url = clean_text(node.get("url")) or clean_text(node.get("@id"))
        if ld_url and not self._is_directory_url(ld_url):
            website = canonical_url(ld_url)
        if not website:
            website = extract_website(soup, self.host)
        description = (
            clean_text(node.get("description"))
            or self._meta_description(soup)
            or self._first_selector(soup, DESCRIPTION_SELECTORS)
        )

        resolved_category = (
            self._category_from_type(node)
            or clean_text(category)
            or self._breadcrumb_category(soup)
        )

        return Lead(
            businessName=name,
            category=resolved_category,
            description=description,
            address=address_info["address"],
            city=address_info["city"],
            state=address_info["state"],
            zip=address_info["zip"],
            phone=phones[0] if phones else None,
            email=emails[0] if emails else None,
            website=canonical_url(website) if website else None,
            source=self.name,
            sourceUrl=canonical_url(url),
            sourceId=self.extract_source_id(url),
            publicEmails=emails,
            publicPhones=phones,
            services=extract_services(soup, blocks),
        )

    # ---------------------------------------------------------------- helpers
    def _business_scope(self, soup: Any) -> Any:
        """Return a copy of the page with *other* businesses' blocks removed.

        A USdirectory profile page embeds listings for additional businesses
        ("nearby"/related). Their mailto:/tel: links were being picked up as if
        they belonged to the business on the page, which merged unrelated
        businesses during dedupe. Any container that links to another business
        profile slug is dropped before contacts are read.
        """
        clone = make_soup(str(soup))
        self_url = canonical_url(getattr(self, "_current_url", "") or "")
        for node in clone.find_all(["ul", "ol", "li", "section", "article", "div"]):
            others = 0
            for anchor in node.find_all("a", href=True):
                href = str(anchor["href"]).strip()
                if not href or href.startswith(("#", "mailto:", "tel:", "javascript:")):
                    continue
                target = canonical_url(absolute(href, self.base_url))
                if self.is_profile_url(target) and target != self_url:
                    others += 1
            if others:
                node.decompose()
        return clone

    def _contacts_for(self, soup: Any, node: dict[str, Any], blocks: list[dict[str, Any]]) -> dict[str, list[str]]:
        """Contacts that genuinely belong to the business on this page.

        JSON-LD first (authoritative), then the page scoped to this business.
        Whole-page text scanning is deliberately avoided: it sweeps up the
        contacts of every other business listed on the page.
        """
        emails: list[str] = []
        phones: list[str] = []

        # 1) schema.org ContactPoint / email / telephone
        structured = extract_json_ld_contact(node)
        for block in blocks:
            structured = extract_json_ld_contact(block)
            emails.extend(structured["emails"])
            phones.extend(structured["phones"])
        emails.extend(structured["emails"])
        phones.extend(structured["phones"])

        # 2) this business' own mailto:/tel: links
        scoped = self._business_scope(soup)
        anchors = extract_contact_points(scoped)
        emails.extend(anchors["emails"])
        phones.extend(anchors["phones"])

        return {
            "emails": [e for e in _dedupe([normalize_email(x) for x in emails]) if e],
            "phones": [p for p in _dedupe([normalize_phone(x) for x in phones]) if p],
        }

    def _is_directory_email(self, email: str) -> bool:
        """True for addresses belonging to the directory itself."""
        domain = email.rsplit("@", 1)[-1].lower() if "@" in email else ""
        return bool(domain) and self.host in domain

    def _is_directory_url(self, url: str) -> bool:
        """True when a URL points back at the directory (self-referencing)."""
        host = (urlparse(url).netloc or "").lower()
        return bool(host) and (self.host in host or host in self.host)

    @staticmethod
    def _first_selector(soup: Any, selectors: tuple[str, ...]) -> str | None:
        for selector in selectors:
            value = first_text(soup.select_one(selector))
            if value and len(value) > 1:
                return value
        return None

    @staticmethod
    def _meta_description(soup: Any) -> str | None:
        for attrs in (
            {"name": "description"},
            {"property": "og:description"},
            {"name": "twitter:description"},
        ):
            meta = soup.find("meta", attrs=attrs)
            if meta and meta.get("content"):
                value = clean_text(meta["content"])
                if value and len(value) > 20:
                    return value
        return None

    @staticmethod
    def _category_from_type(node: dict[str, Any]) -> str | None:
        raw = node.get("@type") or node.get("type")
        if isinstance(raw, list):
            raw = raw[0] if raw else None
        if not isinstance(raw, str):
            return None
        lowered = raw.lower()
        label = BUSINESS_TYPE_LABELS.get(lowered)
        if label and label not in {"Local Business", "Business"}:
            return label
        return None

    @staticmethod
    def _breadcrumb_category(soup: Any) -> str | None:
        crumbs = soup.select(", ".join(BREADCRUMB_SELECTORS))
        if len(crumbs) >= 2:
            value = first_text(crumbs[-1])
            if value and value.lower() not in {"home", "search", "results"}:
                return value
        return None

    def _address(self, soup: Any, node: dict[str, Any], url: str) -> dict[str, str | None]:
        info = extract_address_node(node.get("address"))
        if not info["address"]:
            raw = self._first_selector(soup, ADDRESS_SELECTORS)
            if raw:
                info = extract_postal_from_text(raw)
        if info["state"]:
            info["state"] = state_abbr(str(info["state"])) or info["state"]
        if not info["city"]:
            # Last resort: the city encoded in the profile URL slug
            # (/Business-Name-City-ST-1234). Still source-derived, not invented.
            segments = [seg for seg in (urlparse(url).path or "").strip("/").split("/") if seg]
            if segments:
                tail = segments[-1].split("-")
                if len(tail) >= 3 and len(tail[-2]) == 2:
                    info["city"] = tail[-3].replace("-", " ").title()
        return info


def _dedupe(values: list[str]) -> list[str]:
    out: list[str] = []
    for value in values:
        if value and value not in out:
            out.append(value)
    return out
