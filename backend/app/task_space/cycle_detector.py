"""Incremental reachability cycle detector for the dependency domain.

首版刻意只做**增量可达性 DFS**（依赖域合同 D13）：单人任务规模的边数量
在几十到几百级别，一次 O(V+E) 的可达性遍历完全够用，不需要 Tarjan SCC /
关键链 / 风险传播这类重型图算法。

★ 为什么是"从 candidate_to 出发能否到达 candidate_from"
  规范边的方向是 ``from -> to``（from 被阻塞，to 是上游 blocker）。
  加入 ``f -> t`` 后成环，等价于在**已有边**里存在一条 ``t ⇝ f`` 的路径：
  ``f -> t -> ... -> f``。
  所以只需一次以 t 为根、沿 forward 邻接走的可达性搜索，命中 f 即成环。

★ 纯函数、零 I/O：调用方（TaskSpaceCompiler）负责在同一个 authority
  overlay / UoW 事务视图里把已有边喂进来，避免在路由层做无锁的
  ToCTOU 检测（读到的边集可能已经被并发命令改写）。
"""

from __future__ import annotations

from collections.abc import Iterable

Edge = tuple[str, str]


def detect_cycle_incremental(
    existing_edges: Iterable[Edge],
    candidate_edge: Edge,
) -> tuple[bool, list[str]]:
    """Return ``(has_cycle, cycle_path)`` for adding ``candidate_edge``.

    ``candidate_edge`` is ``(candidate_from, candidate_to)``.  When
    ``candidate_to`` can already reach ``candidate_from`` through
    ``existing_edges``, the new edge closes a cycle and the exact path is
    returned as ``[from, to, ..., from]`` — the first element equals the
    last, so the UI can render the loop without extra bookkeeping.

    A direct self-loop ``(a, a)`` is reported as ``[a, a]`` without touching
    the graph at all.

    The search is iterative (explicit stack) so a pathological deep chain
    cannot blow the Python recursion limit.
    """
    candidate_from, candidate_to = (str(candidate_edge[0]), str(candidate_edge[1]))

    if candidate_from == candidate_to:
        return True, [candidate_from, candidate_from]

    adjacency: dict[str, list[str]] = {}
    for raw_from, raw_to in existing_edges:
        adjacency.setdefault(str(raw_from), []).append(str(raw_to))

    # Depth-first search from candidate_to; ``parent`` rebuilds the path.
    parent: dict[str, str | None] = {candidate_to: None}
    stack: list[str] = [candidate_to]
    while stack:
        node = stack.pop()
        for neighbour in adjacency.get(node, ()):
            if neighbour == candidate_from:
                path = [candidate_from]
                cursor: str | None = node
                while cursor is not None:
                    path.append(cursor)
                    cursor = parent[cursor]
                path.reverse()
                return True, [candidate_from, *path]
            if neighbour in parent:
                continue
            parent[neighbour] = node
            stack.append(neighbour)

    return False, []


def blocking_reachable_set(
    existing_edges: Iterable[Edge],
    origin: str,
) -> set[str]:
    """Return every node reachable from ``origin`` along forward edges.

    Helper for diagnostics and for tests that need the transitive "upstream
    closure" of an item.  ``origin`` itself is never included.
    """
    adjacency: dict[str, list[str]] = {}
    for raw_from, raw_to in existing_edges:
        adjacency.setdefault(str(raw_from), []).append(str(raw_to))

    seen: set[str] = set()
    stack = [str(origin)]
    while stack:
        node = stack.pop()
        for neighbour in adjacency.get(node, ()):
            if neighbour in seen:
                continue
            seen.add(neighbour)
            stack.append(neighbour)
    return seen
