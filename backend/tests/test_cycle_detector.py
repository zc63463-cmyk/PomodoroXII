"""Pure graph-algorithm tests for the incremental cycle detector.

No database, no compiler — just the reachability contract (依赖域合同 D13).
"""
from __future__ import annotations

from app.task_space.cycle_detector import blocking_reachable_set, detect_cycle_incremental


def test_empty_graph_never_cycles() -> None:
    assert detect_cycle_incremental([], ("a", "b")) == (False, [])


def test_direct_self_loop_is_reported_without_touching_the_graph() -> None:
    assert detect_cycle_incremental([], ("a", "a")) == (True, ["a", "a"])
    assert detect_cycle_incremental([("x", "y")], ("a", "a")) == (True, ["a", "a"])


def test_two_node_cycle_returns_the_closed_walk() -> None:
    has_cycle, path = detect_cycle_incremental([("b", "a")], ("a", "b"))
    assert has_cycle is True
    assert path == ["a", "b", "a"]


def test_three_node_indirect_cycle_returns_the_full_path() -> None:
    edges = [("b", "c"), ("c", "d"), ("d", "a")]
    has_cycle, path = detect_cycle_incremental(edges, ("a", "b"))
    assert has_cycle is True
    assert path[0] == path[-1] == "a"
    # Every consecutive pair is a real edge (or the candidate edge).
    assert path == ["a", "b", "c", "d", "a"]


def test_long_chain_cycle_does_not_hit_the_recursion_limit() -> None:
    """A 5000-deep chain would blow a recursive DFS."""
    depth = 5000
    edges = [(f"n{index}", f"n{index + 1}") for index in range(depth)]
    has_cycle, path = detect_cycle_incremental(edges, (f"n{depth}", "n0"))
    assert has_cycle is True
    assert path[0] == path[-1] == f"n{depth}"
    assert len(path) == depth + 2


def test_diamond_is_not_a_cycle() -> None:
    edges = [("bottom", "left"), ("bottom", "right"), ("left", "top")]
    assert detect_cycle_incremental(edges, ("right", "top")) == (False, [])


def test_disconnected_component_is_not_a_cycle() -> None:
    edges = [("x", "y"), ("y", "z")]
    assert detect_cycle_incremental(edges, ("a", "b")) == (False, [])


def test_redeclaring_the_same_edge_is_not_a_cycle() -> None:
    """Re-adding an identical edge is a duplicate, not a cycle.

    The candidate's target ``b`` cannot reach ``a``, so no loop closes.  The
    duplicate is collapsed upstream by the deterministic relation id — the
    detector must not report a false positive here.
    """
    assert detect_cycle_incremental([("a", "b")], ("a", "b")) == (False, [])


def test_reverse_of_an_existing_edge_closes_a_two_node_cycle() -> None:
    assert detect_cycle_incremental([("a", "b")], ("b", "a")) == (True, ["b", "a", "b"])


def test_duplicate_and_self_edges_in_the_existing_set_are_tolerated() -> None:
    edges = [("b", "b"), ("b", "c"), ("b", "c")]
    assert detect_cycle_incremental(edges, ("a", "b")) == (False, [])
    assert detect_cycle_incremental(edges, ("c", "b")) == (True, ["c", "b", "c"])


def test_existing_cycle_elsewhere_does_not_block_an_unrelated_edge() -> None:
    # p -> q -> p is already a cycle, but a -> b is unrelated.
    edges = [("p", "q"), ("q", "p")]
    assert detect_cycle_incremental(edges, ("a", "b"))[0] is False


def test_blocking_reachable_set_excludes_the_origin() -> None:
    edges = [("a", "b"), ("b", "c"), ("a", "c")]
    assert blocking_reachable_set(edges, "a") == {"b", "c"}
    assert blocking_reachable_set(edges, "c") == set()
