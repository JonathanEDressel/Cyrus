"""Robinhood Crypto Trading API — direct integration package.

Exposes the RobinhoodAdapter as the single entry-point for the rest of the
application.  All other modules in this package are internal implementation
details and should not be imported directly outside the package.
"""

from helper.robinhood.adapter import RobinhoodAdapter

__all__ = ["RobinhoodAdapter"]
