"""Centralised selector / fallback registry for directory sources.

Why this module exists
----------------------
Selector knowledge used to be scattered across the source modules, which meant a
single HTML redesign had to be hunted for in several places. Everything a source
needs to read a page now lives here, grouped by *what is being read*, so a future
markup change is a one-line edit in one file.

Extraction priority used by every source (do not reorder):
    1. JSON-LD            (``<script type="application/ld+json">``)
    2. Semantic HTML      (``<address>``, ``<time>``, ``<h1>``)
    3. Microdata          (``itemprop``)
    4. Meta tags          (``<meta name="description">``, ``og:*``)
    5. CSS selectors      (the tables below)
    6. Regex              (only for values already visible in the text)

Every selector list is ordered best-first; the first non-empty match wins.
A value that cannot be found stays ``None`` - selectors never invent data.
"""

from __future__ import annotations

# --------------------------------------------------------------------------- #
# Profile page: business name
# --------------------------------------------------------------------------- #
NAME_SELECTORS: tuple[str, ...] = (
    # JSON-LD is handled separately in the source (highest priority).
    # Semantic HTML / microdata first:
    "[itemprop='name']",
    "h1[itemprop='name']",
    # Common heading shapes:
    "h1.business-name",
    "h1.company-name",
    "h1.listing-name",
    "[data-testid='business-name']",
    ".business-header h1",
    # Generic heading (last resort before giving up):
    "main h1",
    "h1",
)

# --------------------------------------------------------------------------- #
# Profile page: description
# --------------------------------------------------------------------------- #
DESCRIPTION_SELECTORS: tuple[str, ...] = (
    "[itemprop='description']",
    ".business-description",
    ".company-description",
    ".profile-description",
    "[data-testid='business-description']",
    "#about p",
    "#description p",
    ".description",
)

# --------------------------------------------------------------------------- #
# Profile page: address
# --------------------------------------------------------------------------- #
ADDRESS_SELECTORS: tuple[str, ...] = (
    "[itemprop='address']",
    "address[itemprop='address']",
    "address",
    ".business-address",
    ".address",
    "[data-testid='business-address']",
)

# Website links: anchors that point at the business' own site.
WEBSITE_LINK_SELECTORS: tuple[str, ...] = (
    "[itemprop='url']",
    "a.website",
    "[data-testid='website'] a",
    "a[rel~='nofollow'][href^='http']",
)

# Explicit contact links published by the business.
EMAIL_LINK_SELECTORS: tuple[str, ...] = (
    "[itemprop='email']",
    "a[href^='mailto:']",
)
PHONE_LINK_SELECTORS: tuple[str, ...] = (
    "[itemprop='telephone']",
    "a[href^='tel:']",
)

# Services / offerings rendered as markup lists.
SERVICES_SELECTORS: tuple[str, ...] = (
    "[data-testid='services'] li",
    ".services li",
    ".service-list li",
    "#services li",
    "ul.services-list li",
)

# Breadcrumb trails, used as a weak category hint only.
BREADCRUMB_SELECTORS: tuple[str, ...] = (
    ".breadcrumb a",
    "nav[aria-label*='readcrumb' i] a",
    "[itemprop='itemListElement'] a",
)

# --------------------------------------------------------------------------- #
# Search / listing page
# --------------------------------------------------------------------------- #
# Cards that wrap a single business result.
#
# Verified live against USdirectory listing pages: each result is rendered as
# ``div.city-business-row``. The historical names below are kept as fallbacks so
# a redesign of the site (or a different directory) still parses.
LISTING_CARD_SELECTORS: tuple[str, ...] = (
    ".city-business-row",
    "li.listing",
    ".listing",
    ".listing-card",
    ".business-card",
    ".search-result",
    ".result-item",
    ".result",
    "[data-testid='business-card']",
    "li.result",
)

# Anchor text that links to a profile (used when the card shape is unknown).
PROFILE_LINK_SELECTORS: tuple[str, ...] = (
    "a.profile-link",
    "a.view-profile",
    "h3 a",
    "h2 a",
    "h4 a",
)

# Pagination containers - presence of one tells us the site paginates.
PAGINATION_SELECTORS: tuple[str, ...] = (
    "nav[aria-label*='page' i]",
    ".pagination",
    ".pager",
    "[data-testid='pagination']",
    "[class*='pagination']",
)

# Page-number links, used to walk results when there is no rel="next".
PAGE_LINK_SELECTORS: tuple[str, ...] = (
    ".pagination a",
    ".pager a",
    "[data-testid='pagination'] a",
    "nav[aria-label*='page' i] a",
)

# Restriction / block-notice detection lives in ``app.services.restrictions`` so
# that the HTTP layer can import it without a circular dependency.
from ..services.restrictions import CHALLENGE_MARKERS, RESTRICTION_MARKERS, classify_restriction  # noqa: E402,F401