"""Phone normalization tests."""

from __future__ import annotations

import pytest

from app.validators.phones import (
    extract_phones,
    format_phone,
    is_fictional_number,
    is_toll_free,
    normalize_phone,
)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("(555) 0101", None),  # only 7 digits - not a valid NANP number
        ("(503) 555-0101", "+15035550101"),
        ("503.555.0101", "+15035550101"),
        ("+1 503 555 0101", "+15035550101"),
        ("1-503-555-0101", "+15035550101"),
        ("5035550101", "+15035550101"),
        ("503-555-0101 ext. 22", "+15035550101"),
        ("503-555-0101 x22", "+15035550101"),
    ],
)
def test_normalize_phone_valid(raw: str, expected: str | None) -> None:
    assert normalize_phone(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        None,
        "",
        "call us",
        "12345",
        "123456789012345",
        "000-000-0000",  # area code cannot start with 0
        "111-111-1111",  # area code cannot start with 1
        "503-055-0101",  # exchange cannot start with 0
        "503-155-0101",  # exchange cannot start with 1
        "503-555-5555",  # all identical digits
    ],
)
def test_normalize_phone_rejects(raw: str | None) -> None:
    assert normalize_phone(raw) is None


def test_format_phone() -> None:
    assert format_phone("+15035550101") == "(503) 555-0101"
    assert format_phone("nope") is None


def test_extract_phones_from_text_dedupes_and_normalizes() -> None:
    text = "Call (503) 555-0101 or 503.555.0101. Toll free 800-555-0199. Fax 503-555-0101."
    assert extract_phones(text) == ["+15035550101", "+18005550199"]


def test_toll_free_detection() -> None:
    assert is_toll_free("800-555-0199") is True
    assert is_toll_free("503-555-0101") is False


def test_fictional_number_detection() -> None:
    assert is_fictional_number("(503) 555-0101") is True
    assert is_fictional_number("(503) 555-0101") is True
    assert is_fictional_number("503-234-9900") is False
