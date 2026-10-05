"""Four local, read-only source adapters."""


def get_adapters(harnesses=None):
    from .claude import ClaudeAdapter
    from .codex import CodexAdapter
    from .dsh import DshAdapter
    from .omp import OmpAdapter

    factories = {"codex": CodexAdapter, "claude": ClaudeAdapter,
                 "omp": OmpAdapter, "dsh": DshAdapter}
    selected = (list(factories) if harnesses is None else
                [harnesses] if isinstance(harnesses, str) else list(harnesses))
    unknown = set(selected) - set(factories)
    if unknown:
        raise ValueError(f"Unknown harness: {', '.join(sorted(unknown))}")
    return [factories[name]() for name in selected]


def discover_sources(harnesses=None):
    return [source for adapter in get_adapters(harnesses) for source in adapter.discover()]
