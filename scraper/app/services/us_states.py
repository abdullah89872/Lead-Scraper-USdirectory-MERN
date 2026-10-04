"""US state name/abbreviation helpers and free-text location parsing.

Only used to build directory URLs and to normalize a state value that the
source already published (e.g. "Oregon" -> "OR").
"""

from __future__ import annotations

from dataclasses import dataclass

STATE_NAME_TO_ABBR: dict[str, str] = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR",
    "california": "CA", "colorado": "CO", "connecticut": "CT", "delaware": "DE",
    "district of columbia": "DC", "florida": "FL", "georgia": "GA", "hawaii": "HI",
    "idaho": "ID", "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS",
    "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD",
    "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS",
    "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV",
    "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
    "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK",
    "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI",
    "south carolina": "SC", "south dakota": "SD", "tennessee": "TN", "texas": "TX",
    "utah": "UT", "vermont": "VT", "virginia": "VA", "washington": "WA",
    "west virginia": "WV", "wisconsin": "WI", "wyoming": "WY",
}
STATE_ABBR_TO_NAME: dict[str, str] = {v: k.title() for k, v in STATE_NAME_TO_ABBR.items()}
# Common aliases that appear in user input.
STATE_ALIASES = {"washington dc": "DC", "washington, dc": "DC", "d.c.": "DC", "usa": ""}


class LocationError(ValueError):
    """Raised when a location string cannot be resolved to a state (+ city)."""


@dataclass
class LocationParts:
    raw: str
    city: str | None = None
    state_name: str | None = None
    state_abbr: str | None = None

    @property
    def has_state(self) -> bool:
        return bool(self.state_name)


def state_abbr(value: str | None) -> str | None:
    """'Oregon' -> 'OR', 'or' -> 'OR', 'OR' -> 'OR'."""
    if not value:
        return None
    candidate = " ".join(value.split()).strip().lower().rstrip(".")
    if candidate in STATE_ALIASES:
        return STATE_ALIASES[candidate] or None
    if candidate in STATE_NAME_TO_ABBR:
        return STATE_NAME_TO_ABBR[candidate]
    if len(candidate) == 2 and candidate.upper() in STATE_ABBR_TO_NAME:
        return candidate.upper()
    return None


def state_name(value: str | None) -> str | None:
    abbr = state_abbr(value)
    if abbr:
        return STATE_ABBR_TO_NAME.get(abbr)
    return None


def parse_location(location: str) -> LocationParts:
    """Parse free text such as ``Hillsboro, Oregon`` / ``Hillsboro, OR``.

    Raises :class:`LocationError` when no US state can be recognised, so the
    caller can report a clear validation error instead of scraping nonsense.
    """
    raw = " ".join((location or "").split())
    if not raw:
        raise LocationError("location is required")

    parts = [piece.strip() for piece in raw.split(",") if piece.strip()]

    # People naturally type the Google-style "Atlanta, GA, USA". Drop a trailing
    # country token (USA / US / United States / U.S.) before parsing, otherwise
    # the state is read as "USA" and the whole location is rejected.
    country_tokens = {"usa", "us", "u.s.", "u.s.a.", "united states", "united states of america"}
    while len(parts) > 2 and parts[-1].lower() in country_tokens:
        parts.pop()
    if len(parts) == 2 and parts[-1].lower() in country_tokens:
        parts.pop()

    city: str | None = None
    state: str | None = None

    if len(parts) >= 2:
        city = parts[0]
        state = parts[-1]
    else:
        single = parts[0]
        if state_abbr(single):
            state = single
        else:
            # "Hillsboro OR" / "Portland Oregon"
            tokens = single.split()
            if len(tokens) >= 2 and state_abbr(tokens[-1]):
                state = tokens[-1]
                city = " ".join(tokens[:-1])
            else:
                city = single

    abbr = state_abbr(state)
    if not abbr:
        raise LocationError(
            f"could not resolve a US state from '{location}'. "
            "Use a format like 'Hillsboro, Oregon' or 'Hillsboro, OR'."
        )

    return LocationParts(
        raw=raw,
        city=city or None,
        state_name=STATE_ABBR_TO_NAME.get(abbr),
        state_abbr=abbr,
    )
