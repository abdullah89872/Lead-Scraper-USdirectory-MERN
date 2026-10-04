"""Email extraction and validation tests."""

from __future__ import annotations

import pytest

from app.validators.emails import (
    EMAIL_RE,
    deobfuscate,
    email_status,
    extract_emails,
    is_junk_email,
    is_valid_email,
    normalize_email,
)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("INFO@Example.com", "info@example.com"),
        ("mailto:sales@acme.com", "sales@acme.com"),
        ("mailto:sales@acme.com?subject=Hi", "sales@acme.com"),
        ("  quotes@acme.com , ", "quotes@acme.com"),
        ("<bids@acme.com>", "bids@acme.com"),
        (None, None),
        ("no-at-sign", None),
    ],
)
def test_normalize_email(raw: str | None, expected: str | None) -> None:
    assert normalize_email(raw) == expected


@pytest.mark.parametrize(
    ("value", "valid"),
    [
        ("info@acme.com", True),
        ("info@acme", False),
        ("info@@acme.com", False),
        ("", False),
    ],
)
def test_is_valid_email(value: str, valid: bool) -> None:
    assert is_valid_email(value) is valid


def test_extract_emails_filters_assets_and_placeholders() -> None:
    html = (
        "Contact info@acme.com or info@acme.com. "
        "Logo: logo@2x.png. Placeholder: yourname@example.com. "
        "Sentry key abcd1234@sentry.io."
    )
    assert extract_emails(html) == ["info@acme.com"]


def test_deobfuscation_of_common_patterns() -> None:
    assert "office@acme.com" in extract_emails("email office (at) acme (dot) com")
    assert "bids@acme.com" in extract_emails("bids [at] acme [dot] com")
    assert deobfuscate("name at acme dot com") == "name@acme.com"


def test_email_regex_ignores_trailing_punctuation() -> None:
    found = EMAIL_RE.findall("Write to support@acme.com.")
    assert found == ["support@acme.com"]


def test_junk_email_detection() -> None:
    assert is_junk_email("logo@2x.png") is True
    assert is_junk_email("yourname@example.com") is True
    assert is_junk_email("real.person@acme.com") is False


def test_email_status() -> None:
    assert email_status([]) == "unknown"
    assert email_status(["info@acme.com"]) == "valid"
    assert email_status(["broken@"]) == "invalid"
