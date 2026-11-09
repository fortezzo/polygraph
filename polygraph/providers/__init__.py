"""Connectors that send questions to AI models."""

from polygraph.providers.base import Message, Provider, ProviderError, Reply
from polygraph.providers.ollama import OllamaProvider

__all__ = ["Message", "OllamaProvider", "Provider", "ProviderError", "Reply"]
