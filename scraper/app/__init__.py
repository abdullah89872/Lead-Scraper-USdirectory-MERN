"""LeadForge AI scraper service.

The scraper is intentionally independent from the Node backend: it exposes a
small FastAPI surface (``/health``, ``/sources``, ``/scrape``, ``/enrich``) and
knows nothing about MongoDB, JWT or the queue.
"""

__version__ = "1.0.0"
