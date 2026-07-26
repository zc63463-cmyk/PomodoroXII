from __future__ import annotations

import argparse
import ast
import re
from dataclasses import dataclass, field
from pathlib import Path

S3_ROUTE_FILES = (
    Path("routes/v1/notes.py"),
    Path("routes/v1/folders.py"),
    Path("routes/v1/quick_notes.py"),
    Path("routes/v1/trash.py"),
    Path("routes/v1/schedules.py"),
    Path("routes/v1/habits.py"),
    Path("routes/v1/reflections.py"),
    Path("routes/v1/time_blocks.py"),
)
WRITE_CONSTRUCTORS = {"insert", "update", "delete"}
ORM_WRITE_METHODS = {
    "add", "add_all", "merge", "delete",
    "bulk_save_objects", "bulk_insert_mappings", "bulk_update_mappings",
}
PATH_MUTATORS = {
    "write_text", "write_bytes", "unlink", "rename", "replace",
    "mkdir", "rmdir", "touch", "write", "writelines", "truncate",
}
FILE_MODULE_OWNERS = {"os", "shutil"}
FILE_MODULE_MUTATORS = {
    "remove", "unlink", "rename", "replace", "mkdir", "makedirs",
    "rmdir", "removedirs", "copy", "copy2", "copyfile", "move",
}
INDEX_OWNERS = {"index", "index_store", "search_index", "fts"}
INDEX_MUTATORS = {"add", "delete", "remove", "upsert", "rebuild", "update"}
RAW_SQL_WRITE = re.compile(
    r"\b(?:INSERT|UPDATE|DELETE|MERGE|REPLACE|CREATE|ALTER|DROP|TRUNCATE|"
    r"VACUUM|REINDEX|ATTACH|DETACH)\b|\bPRAGMA\b[^\r\n;]*=",
    re.IGNORECASE,
)
RAW_SQL_READ = re.compile(r"\b(?:SELECT|WITH)\b", re.IGNORECASE)
SYNC_OUTBOX_SQL = re.compile(r"\bsync_outbox\b", re.IGNORECASE)


@dataclass
class AliasFacts:
    relation_names: dict[str, str] = field(
        default_factory=lambda: {"SyncOutbox": "canonical"}
    )
    sqlalchemy_modules: set[str] = field(default_factory=set)
    select_names: set[str] = field(default_factory=lambda: {"select"})
    and_names: set[str] = field(default_factory=lambda: {"and_"})
    aliased_names: set[str] = field(default_factory=lambda: {"aliased"})
    text_names: set[str] = field(default_factory=lambda: {"text"})
    table_names: set[str] = field(default_factory=lambda: {"Table"})
    write_constructor_names: set[str] = field(
        default_factory=lambda: set(WRITE_CONSTRUCTORS)
    )
    table_aliases: set[str] = field(default_factory=set)
    write_statement_aliases: set[str] = field(default_factory=set)
    orm_write_aliases: set[str] = field(default_factory=set)
    session_aliases: set[str] = field(default_factory=lambda: {"db", "session"})
    session_type_names: set[str] = field(
        default_factory=lambda: {"Session", "AsyncSession"}
    )
    sql_executor_aliases: set[str] = field(default_factory=set)
    raw_sql_executor_aliases: set[str] = field(default_factory=set)
    static_strings: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class SyncOutboxRead:
    node: ast.Call
    relation_ids: frozenset[str]
    kind: str


def dotted_name(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        prefix = dotted_name(node.value)
        return f"{prefix}.{node.attr}" if prefix else node.attr
    return ""


def assigned_names(node: ast.AST) -> tuple[str, ...]:
    if isinstance(node, ast.Name):
        return (node.id,)
    if isinstance(node, (ast.Tuple, ast.List)):
        return tuple(
            name
            for item in node.elts
            for name in assigned_names(item)
        )
    return ()


def call_matches(
    func: ast.AST,
    names: set[str],
    modules: set[str],
    canonical: str,
) -> bool:
    name = dotted_name(func)
    return name in names or any(name == f"{module}.{canonical}" for module in modules)


def static_string(
    node: ast.AST,
    bindings: dict[str, str],
    seen: frozenset[str] = frozenset(),
) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.Name):
        if node.id in seen:
            return None
        return bindings.get(node.id)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left = static_string(node.left, bindings, seen)
        right = static_string(node.right, bindings, seen)
        return None if left is None or right is None else left + right
    if isinstance(node, ast.JoinedStr):
        parts: list[str] = []
        for value in node.values:
            if isinstance(value, ast.Constant) and isinstance(value.value, str):
                parts.append(value.value)
            elif isinstance(value, ast.FormattedValue):
                rendered = static_string(value.value, bindings, seen)
                if rendered is None:
                    return None
                parts.append(rendered)
            else:
                return None
        return "".join(parts)
    if (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "join"
        and len(node.args) == 1
        and isinstance(node.args[0], (ast.Tuple, ast.List))
    ):
        separator = static_string(node.func.value, bindings, seen)
        values = [static_string(item, bindings, seen) for item in node.args[0].elts]
        if separator is not None and all(value is not None for value in values):
            return separator.join(value for value in values if value is not None)
    return None


def static_sql_candidate(node: ast.AST, facts: AliasFacts) -> str:
    exact = static_string(node, facts.static_strings)
    if exact is not None:
        return exact
    if isinstance(node, ast.Call):
        resolved = [
            static_string(argument, facts.static_strings)
            for argument in (*node.args, *(item.value for item in node.keywords))
        ]
        if any(value is not None for value in resolved):
            return "".join(value for value in resolved if value is not None)
    return "".join(
        item.value
        for item in ast.walk(node)
        if isinstance(item, ast.Constant) and isinstance(item.value, str)
    )


def is_table_call(node: ast.AST, facts: AliasFacts) -> bool:
    return (
        isinstance(node, ast.Call)
        and call_matches(
            node.func, facts.table_names, facts.sqlalchemy_modules, "Table"
        )
        and bool(node.args)
        and static_string(node.args[0], facts.static_strings) == "sync_outbox"
    )


def relation_ids(node: ast.AST, facts: AliasFacts) -> set[str]:
    if isinstance(node, ast.Name):
        relation = facts.relation_names.get(node.id)
        return {relation} if relation is not None else set()
    if isinstance(node, ast.Attribute):
        if node.attr == "SyncOutbox":
            return {"canonical"}
        return relation_ids(node.value, facts)
    if isinstance(node, ast.Subscript):
        key = static_string(node.slice, facts.static_strings)
        if key == "sync_outbox" and dotted_name(node.value).endswith(".tables"):
            return {"canonical"}
        return relation_ids(node.value, facts)
    if isinstance(node, ast.Starred):
        return relation_ids(node.value, facts)
    if isinstance(node, ast.Call):
        if is_table_call(node, facts):
            return {f"inline-table:{node.lineno}:{node.col_offset}"}
        if (
            isinstance(node.func, ast.Attribute)
            and node.func.attr in ("alias", "subquery")
            and relation_ids(node.func.value, facts)
        ):
            return {f"inline-table-alias:{node.lineno}:{node.col_offset}"}
        if call_matches(
            node.func, facts.aliased_names, facts.sqlalchemy_modules, "aliased"
        ) and node.args and relation_ids(node.args[0], facts):
            return {f"inline-alias:{node.lineno}:{node.col_offset}"}
        found: set[str] = set()
        for argument in (*node.args, *(item.value for item in node.keywords)):
            found.update(relation_ids(argument, facts))
        return found
    if isinstance(node, (ast.Tuple, ast.List, ast.Set)):
        found: set[str] = set()
        for item in node.elts:
            found.update(relation_ids(item, facts))
        return found
    if isinstance(node, ast.Dict):
        found: set[str] = set()
        for item in (*node.keys, *node.values):
            if item is not None:
                found.update(relation_ids(item, facts))
        return found
    return set()


def is_sync_outbox_ref(node: ast.AST, facts: AliasFacts) -> bool:
    return bool(relation_ids(node, facts))


def is_table_expression(node: ast.AST, facts: AliasFacts) -> bool:
    if isinstance(node, ast.Name) and node.id in facts.table_aliases:
        return True
    if is_table_call(node, facts):
        return True
    if isinstance(node, ast.Attribute) and node.attr == "__table__":
        return True
    if isinstance(node, ast.Subscript):
        return dotted_name(node.value).endswith(".tables")
    if (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr in {"alias", "subquery"}
    ):
        return is_table_expression(node.func.value, facts)
    return False


def is_session_receiver(node: ast.AST, facts: AliasFacts) -> bool:
    parts = [part.lower() for part in dotted_name(node).split(".") if part]
    return any(
        part in {"db", "session"}
        or part.endswith("_db")
        or part.endswith("_session")
        or part in facts.session_aliases
        for part in parts
    )


def is_write_constructor_ref(node: ast.AST, facts: AliasFacts) -> bool:
    name = dotted_name(node)
    leaf = name.rsplit(".", 1)[-1]
    if name in facts.write_constructor_names:
        return True
    if leaf in WRITE_CONSTRUCTORS and any(
        name == f"{module}.{leaf}" for module in facts.sqlalchemy_modules
    ):
        return True
    return (
        isinstance(node, ast.Attribute)
        and node.attr in WRITE_CONSTRUCTORS
        and is_table_expression(node.value, facts)
    )


def is_raw_sql_write(node: ast.AST, facts: AliasFacts) -> bool:
    sql = static_sql_candidate(node, facts)
    if isinstance(node, ast.Call):
        leaf = dotted_name(node.func).rsplit(".", 1)[-1]
        is_raw_entry = (
            call_matches(node.func, facts.text_names, facts.sqlalchemy_modules, "text")
            or leaf == "exec_driver_sql"
        )
        if is_raw_entry and not sql:
            return True
    return RAW_SQL_WRITE.search(sql) is not None


def is_session_annotation(node: ast.AST | None, facts: AliasFacts) -> bool:
    if node is None:
        return False
    return any(
        (isinstance(item, ast.Name) and item.id in facts.session_type_names)
        or (
            isinstance(item, ast.Attribute)
            and item.attr in {"Session", "AsyncSession"}
        )
        for item in ast.walk(node)
    )


def is_write_statement_expr(
    node: ast.AST,
    facts: AliasFacts,
    seen: frozenset[int] = frozenset(),
) -> bool:
    if id(node) in seen:
        return False
    seen = seen | {id(node)}
    if isinstance(node, ast.Name):
        return node.id in facts.write_statement_aliases
    if isinstance(node, ast.Await):
        return is_write_statement_expr(node.value, facts, seen)
    if not isinstance(node, ast.Call):
        return False
    if is_write_constructor_ref(node.func, facts):
        return True
    if call_matches(node.func, facts.text_names, facts.sqlalchemy_modules, "text"):
        return is_raw_sql_write(node, facts)
    if isinstance(node.func, ast.Attribute):
        if is_write_statement_expr(node.func.value, facts, seen):
            return True
        if (
            node.func.attr in {"update", "delete"}
            and isinstance(node.func.value, ast.Call)
            and isinstance(node.func.value.func, ast.Attribute)
            and node.func.value.func.attr == "query"
            and is_session_receiver(node.func.value.func.value, facts)
        ):
            return True
    return False


def discover_aliases(tree: ast.AST) -> AliasFacts:
    facts = AliasFacts()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for item in node.names:
                local = item.asname or item.name.split(".", 1)[0]
                if item.name.startswith("sqlalchemy"):
                    facts.sqlalchemy_modules.add(local)
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            for item in node.names:
                local = item.asname or item.name
                if item.name == "SyncOutbox":
                    facts.relation_names[local] = "canonical"
                if module.startswith("sqlalchemy"):
                    if item.name in {"Session", "AsyncSession"}:
                        facts.session_type_names.add(local)
                    elif item.name == "select":
                        facts.select_names.add(local)
                    elif item.name == "and_":
                        facts.and_names.add(local)
                    elif item.name == "aliased":
                        facts.aliased_names.add(local)
                    elif item.name == "text":
                        facts.text_names.add(local)
                    elif item.name == "Table":
                        facts.table_names.add(local)
                    elif item.name in WRITE_CONSTRUCTORS:
                        facts.write_constructor_names.add(local)

    for node in ast.walk(tree):
        if isinstance(node, ast.arg) and is_session_annotation(node.annotation, facts):
            facts.session_aliases.add(node.arg)
        elif (
            isinstance(node, ast.AnnAssign)
            and isinstance(node.target, ast.Name)
            and is_session_annotation(node.annotation, facts)
        ):
            facts.session_aliases.add(node.target.id)

    assignments = [
        node for node in ast.walk(tree)
        if isinstance(node, (ast.Assign, ast.AnnAssign))
    ]
    for _ in range(len(assignments) + 1):
        changed = False
        for assignment in assignments:
            targets = (
                tuple(
                    name
                    for target in assignment.targets
                    for name in assigned_names(target)
                )
                if isinstance(assignment, ast.Assign)
                else assigned_names(assignment.target)
            )
            value = assignment.value
            if value is None or not targets:
                continue
            rendered = static_string(value, facts.static_strings)
            if rendered is not None:
                for target in targets:
                    if facts.static_strings.get(target) != rendered:
                        facts.static_strings[target] = rendered
                        changed = True

            if is_session_receiver(value, facts):
                for target in targets:
                    if target not in facts.session_aliases:
                        facts.session_aliases.add(target)
                        changed = True

            if call_matches(
                value, facts.table_names, facts.sqlalchemy_modules, "Table"
            ):
                for target in targets:
                    if target not in facts.table_names:
                        facts.table_names.add(target)
                        changed = True

            if (
                isinstance(value, ast.Call)
                and call_matches(
                    value.func,
                    facts.aliased_names,
                    facts.sqlalchemy_modules,
                    "aliased",
                )
                and value.args
                and relation_ids(value.args[0], facts)
            ):
                for target in targets:
                    relation = f"alias:{target}"
                    if facts.relation_names.get(target) != relation:
                        facts.relation_names[target] = relation
                        changed = True
            elif isinstance(value, (ast.Name, ast.Attribute, ast.Subscript)):
                relations = relation_ids(value, facts)
                if len(relations) == 1:
                    relation = next(iter(relations))
                    for target in targets:
                        if facts.relation_names.get(target) != relation:
                            facts.relation_names[target] = relation
                            changed = True

            table_value = is_table_expression(value, facts)
            if table_value and isinstance(value, ast.Call):
                table_relations = relation_ids(value, facts)
                if table_relations:
                    for target in targets:
                        relation = f"table-alias:{target}"
                        if facts.relation_names.get(target) != relation:
                            facts.relation_names[target] = relation
                            changed = True
            if table_value:
                for target in targets:
                    if target not in facts.table_aliases:
                        facts.table_aliases.add(target)
                        changed = True

            if is_write_constructor_ref(value, facts):
                for target in targets:
                    if target not in facts.write_constructor_names:
                        facts.write_constructor_names.add(target)
                        changed = True
            if is_write_statement_expr(value, facts):
                for target in targets:
                    if target not in facts.write_statement_aliases:
                        facts.write_statement_aliases.add(target)
                        changed = True
            if (
                isinstance(value, ast.Attribute)
                and value.attr in ORM_WRITE_METHODS
                and is_session_receiver(value.value, facts)
            ) or (isinstance(value, ast.Name) and value.id in facts.orm_write_aliases):
                for target in targets:
                    if target not in facts.orm_write_aliases:
                        facts.orm_write_aliases.add(target)
                        changed = True
            if (
                isinstance(value, ast.Attribute)
                and value.attr in {"execute", "scalar", "scalars", "exec_driver_sql"}
                and is_session_receiver(value.value, facts)
            ) or (
                isinstance(value, ast.Name)
                and value.id in facts.sql_executor_aliases
            ):
                for target in targets:
                    if target not in facts.sql_executor_aliases:
                        facts.sql_executor_aliases.add(target)
                        changed = True
            if (
                isinstance(value, ast.Attribute)
                and value.attr == "exec_driver_sql"
                and is_session_receiver(value.value, facts)
            ) or (
                isinstance(value, ast.Name)
                and value.id in facts.raw_sql_executor_aliases
            ):
                for target in targets:
                    if target not in facts.raw_sql_executor_aliases:
                        facts.raw_sql_executor_aliases.add(target)
                        changed = True
        if not changed:
            break
    return facts


def chain_root(node: ast.AST, parents: dict[ast.AST, ast.AST]) -> ast.AST:
    current = node
    while current in parents:
        parent = parents[current]
        if isinstance(parent, ast.Attribute) and parent.value is current:
            current = parent
            continue
        if isinstance(parent, ast.Call) and parent.func is current:
            current = parent
            continue
        break
    return current


def query_chain_calls(root: ast.AST) -> tuple[ast.Call, ...]:
    calls: list[ast.Call] = []
    current = root
    while isinstance(current, ast.Call):
        calls.append(current)
        if isinstance(current.func, ast.Attribute) and isinstance(
            current.func.value, ast.Call
        ):
            current = current.func.value
            continue
        break
    return tuple(calls)


def is_select_call(node: ast.Call, facts: AliasFacts) -> bool:
    return call_matches(
        node.func, facts.select_names, facts.sqlalchemy_modules, "select"
    )


def raw_sync_outbox_read(node: ast.Call, facts: AliasFacts) -> str | None:
    leaf = dotted_name(node.func).rsplit(".", 1)[-1]
    is_raw_entry = (
        call_matches(node.func, facts.text_names, facts.sqlalchemy_modules, "text")
        or leaf == "exec_driver_sql"
        or (
            isinstance(node.func, ast.Name)
            and node.func.id in facts.raw_sql_executor_aliases
        )
    )
    is_sql_executor = leaf == "execute" or (
        isinstance(node.func, ast.Name)
        and node.func.id in facts.sql_executor_aliases
    )
    if not (is_raw_entry or is_sql_executor):
        return None
    sql = static_sql_candidate(node, facts)
    arguments = (*node.args, *(item.value for item in node.keywords))
    references_relation = any(
        relation_ids(item, facts)
        for argument in arguments
        for item in ast.walk(argument)
    )
    sql_argument = node.args[0] if node.args else next(
        (
            item.value
            for item in node.keywords
            if item.arg in {"text", "statement", "sql"}
        ),
        None,
    )
    resolved_sql = (
        static_string(sql_argument, facts.static_strings)
        if sql_argument is not None
        else None
    )
    if is_raw_entry and (sql_argument is None or resolved_sql is None):
        return "raw-dynamic"
    if is_raw_entry:
        sql = resolved_sql or ""
    if (
        RAW_SQL_READ.search(sql) is not None
        and (SYNC_OUTBOX_SQL.search(sql) is not None or references_relation)
    ):
        return "raw"
    return None


def is_known_relation_consumer(node: ast.Call, facts: AliasFacts) -> bool:
    if (
        is_select_call(node, facts)
        or call_matches(
            node.func, facts.aliased_names, facts.sqlalchemy_modules, "aliased"
        )
        or is_table_call(node, facts)
        or is_write_constructor_ref(node.func, facts)
    ):
        return True
    if not isinstance(node.func, ast.Attribute):
        return False
    leaf = node.func.attr
    if leaf in {"query", "get", "get_one"}:
        return is_session_receiver(node.func.value, facts)
    return leaf in {
        "select_from", "join", "outerjoin", "where", "filter", "filter_by",
        "order_by", "group_by", "having",
    }


def argument_has_relation_escape(node: ast.AST, facts: AliasFacts) -> bool:
    if isinstance(node, (ast.Name, ast.Attribute, ast.Subscript)):
        return is_sync_outbox_ref(node, facts)
    if isinstance(node, ast.Starred):
        return argument_has_relation_escape(node.value, facts)
    if isinstance(node, (ast.Tuple, ast.List, ast.Set)):
        return any(argument_has_relation_escape(item, facts) for item in node.elts)
    if isinstance(node, ast.Dict):
        return any(
            item is not None and argument_has_relation_escape(item, facts)
            for item in (*node.keys, *node.values)
        )
    return False


def collect_unknown_relation_escapes(
    tree: ast.AST,
    facts: AliasFacts,
    parents: dict[ast.AST, ast.AST],
) -> tuple[ast.AST, ...]:
    escapes: list[ast.AST] = []
    containers = (ast.Tuple, ast.List, ast.Set, ast.Dict)
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            if is_known_relation_consumer(node, facts):
                continue
            arguments = (*node.args, *(item.value for item in node.keywords))
            if any(argument_has_relation_escape(item, facts) for item in arguments):
                escapes.append(node)
            continue
        if not isinstance(node, containers) or not argument_has_relation_escape(
            node, facts
        ):
            continue
        parent = parents.get(node)
        if isinstance(parent, containers):
            continue
        current: ast.AST = node
        while isinstance(parents.get(current), (ast.Starred, ast.keyword)):
            current = parents[current]
        if isinstance(parents.get(current), ast.Call):
            continue
        escapes.append(node)
    return tuple(escapes)


def collect_sync_outbox_reads(
    tree: ast.AST,
    facts: AliasFacts,
    parents: dict[ast.AST, ast.AST],
) -> tuple[SyncOutboxRead, ...]:
    reads: list[SyncOutboxRead] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        raw_kind = raw_sync_outbox_read(node, facts)
        if raw_kind is not None:
            reads.append(SyncOutboxRead(node, frozenset(), raw_kind))
            continue
        leaf = dotted_name(node.func).rsplit(".", 1)[-1]
        relations: set[str] = set()
        kind = ""
        if is_select_call(node, facts):
            kind = "select"
            for argument in (*node.args, *(item.value for item in node.keywords)):
                relations.update(relation_ids(argument, facts))
            root = chain_root(node, parents)
            for chained in query_chain_calls(root):
                chained_leaf = dotted_name(chained.func).rsplit(".", 1)[-1]
                if chained_leaf in {"select_from", "join", "outerjoin"}:
                    for argument in chained.args:
                        relations.update(relation_ids(argument, facts))
        elif (
            leaf == "query"
            and isinstance(node.func, ast.Attribute)
            and is_session_receiver(node.func.value, facts)
        ):
            kind = "query"
            for argument in node.args:
                relations.update(relation_ids(argument, facts))
        elif (
            leaf == "select"
            and isinstance(node.func, ast.Attribute)
            and is_table_expression(node.func.value, facts)
        ):
            kind = "table-select"
            relations.update(relation_ids(node.func.value, facts))
        elif (
            leaf in {"get", "get_one"}
            and isinstance(node.func, ast.Attribute)
            and is_session_receiver(node.func.value, facts)
            and node.args
        ):
            kind = "direct-get"
            relations.update(relation_ids(node.args[0], facts))
        if relations:
            reads.append(SyncOutboxRead(node, frozenset(relations), kind))
    return tuple(reads)


def top_level_and_conjuncts(
    node: ast.AST,
    facts: AliasFacts,
) -> tuple[ast.AST, ...]:
    if (
        isinstance(node, ast.Call)
        and call_matches(node.func, facts.and_names, facts.sqlalchemy_modules, "and_")
    ):
        return tuple(
            conjunct
            for argument in node.args
            for conjunct in top_level_and_conjuncts(argument, facts)
        )
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitAnd):
        return (
            *top_level_and_conjuncts(node.left, facts),
            *top_level_and_conjuncts(node.right, facts),
        )
    return (node,)


def visible_true_relation_ids(node: ast.AST, facts: AliasFacts) -> set[str]:
    if (
        not isinstance(node, ast.Call)
        or not isinstance(node.func, ast.Attribute)
        or node.func.attr != "is_"
        or len(node.args) != 1
        or not isinstance(node.args[0], ast.Constant)
        or node.args[0].value is not True
    ):
        return set()
    visible = node.func.value
    if not isinstance(visible, ast.Attribute) or visible.attr != "visible":
        return set()
    owner = visible.value
    if isinstance(owner, ast.Attribute) and owner.attr == "c":
        owner = owner.value
    return relation_ids(owner, facts)


def read_has_visible_conjunct(
    read: SyncOutboxRead,
    root: ast.AST,
    facts: AliasFacts,
) -> tuple[bool, bool]:
    visible_relations: set[str] = set()
    unsafe_nested_visibility = False
    for chained in query_chain_calls(root):
        if dotted_name(chained.func).rsplit(".", 1)[-1] not in {"where", "filter"}:
            continue
        for predicate in chained.args:
            for conjunct in top_level_and_conjuncts(predicate, facts):
                relation = visible_true_relation_ids(conjunct, facts)
                if relation:
                    visible_relations.update(relation)
                elif any(
                    visible_true_relation_ids(item, facts)
                    for item in ast.walk(conjunct)
                ):
                    unsafe_nested_visibility = True
    return (
        read.relation_ids <= visible_relations and not unsafe_nested_visibility,
        unsafe_nested_visibility,
    )


def is_statically_dead(
    node: ast.AST,
    parents: dict[ast.AST, ast.AST],
) -> bool:
    current = node
    while current in parents:
        parent = parents[current]
        if isinstance(parent, (ast.If, ast.While)):
            try:
                condition = ast.literal_eval(parent.test)
            except (ValueError, TypeError, SyntaxError):
                condition = None
            if condition is False and current in parent.body:
                return True
            if isinstance(parent, ast.If) and condition is True and current in parent.orelse:
                return True
        current = parent
    return False


def attribute_write_targets(node: ast.AST) -> tuple[ast.Attribute, ...]:
    targets: tuple[ast.AST, ...] = ()
    if isinstance(node, ast.Assign):
        targets = tuple(node.targets)
    elif isinstance(node, (ast.AnnAssign, ast.AugAssign, ast.NamedExpr)):
        targets = (node.target,)
    elif isinstance(node, ast.Delete):
        targets = tuple(node.targets)
    return tuple(
        item
        for target in targets
        for item in ast.walk(target)
        if isinstance(item, ast.Attribute) and isinstance(item.ctx, (ast.Store, ast.Del))
    )


def opens_for_write(node: ast.Call) -> bool:
    if dotted_name(node.func).rsplit(".", 1)[-1] != "open":
        return False
    mode: ast.AST | None = node.args[1] if len(node.args) > 1 else None
    for keyword in node.keywords:
        if keyword.arg == "mode":
            mode = keyword.value
    if mode is None:
        return False
    if not isinstance(mode, ast.Constant) or not isinstance(mode.value, str):
        return True
    return any(flag in mode.value for flag in "wax+")


def route_violations(tree: ast.AST, path: Path, facts: AliasFacts) -> list[str]:
    violations: list[str] = []
    for node in ast.walk(tree):
        for target in attribute_write_targets(node):
            violations.append(
                f"{path}:{target.lineno}: forbidden route ORM attribute assignment"
            )
        if not isinstance(node, ast.Call):
            continue
        name = dotted_name(node.func)
        leaf = name.rsplit(".", 1)[-1]
        parts = {part.lower() for part in name.split(".")}
        if leaf in {"commit", "flush", "record_sync_event"}:
            violations.append(f"{path}:{node.lineno}: forbidden route call {name}")
        elif (
            leaf in ORM_WRITE_METHODS
            and isinstance(node.func, ast.Attribute)
            and is_session_receiver(node.func.value, facts)
        ) or (isinstance(node.func, ast.Name) and node.func.id in facts.orm_write_aliases):
            violations.append(
                f"{path}:{node.lineno}: forbidden route ORM write {name}"
            )
        elif leaf == "setattr":
            violations.append(
                f"{path}:{node.lineno}: forbidden route ORM attribute assignment"
            )
        elif (
            leaf == "exec_driver_sql" and is_raw_sql_write(node, facts)
        ) or (
            isinstance(node.func, ast.Name)
            and node.func.id in facts.raw_sql_executor_aliases
            and (
                not node.args
                or not static_sql_candidate(node.args[0], facts)
                or is_raw_sql_write(node.args[0], facts)
            )
        ) or (
            (
                leaf in {"execute", "scalar", "scalars"}
                or (
                    isinstance(node.func, ast.Name)
                    and node.func.id in facts.sql_executor_aliases
                )
            )
            and any(
                is_write_statement_expr(argument, facts)
                or is_raw_sql_write(argument, facts)
                for argument in (*node.args, *(item.value for item in node.keywords))
            )
        ):
            violations.append(f"{path}:{node.lineno}: direct SQL write execute")
        elif call_matches(
            node.func, facts.text_names, facts.sqlalchemy_modules, "text"
        ) and is_raw_sql_write(node, facts):
            violations.append(f"{path}:{node.lineno}: raw SQL write")
        elif opens_for_write(node):
            violations.append(f"{path}:{node.lineno}: direct write-mode open")
        elif leaf in PATH_MUTATORS:
            violations.append(f"{path}:{node.lineno}: direct filesystem mutator {name}")
        elif leaf in FILE_MODULE_MUTATORS and parts & FILE_MODULE_OWNERS:
            violations.append(
                f"{path}:{node.lineno}: direct filesystem API mutator {name}"
            )
        elif leaf in INDEX_MUTATORS and parts & INDEX_OWNERS:
            violations.append(f"{path}:{node.lineno}: direct index mutator {name}")
    return violations


def parse_app(app_root: Path) -> dict[Path, ast.AST]:
    app_files = tuple(sorted(app_root.rglob("*.py")))
    if not app_files:
        raise SystemExit("no backend/app Python files found")
    trees: dict[Path, ast.AST] = {}
    for app_file in app_files:
        try:
            trees[app_file] = ast.parse(
                app_file.read_text(encoding="utf-8"), filename=str(app_file)
            )
        except (OSError, UnicodeError, SyntaxError) as exc:
            raise SystemExit(f"{app_file}: AST parse failed: {exc}") from exc
    return trees


def run_gate(app_root: Path, include_routes: tuple[Path, ...]) -> tuple[int, int, int]:
    trees = parse_app(app_root)
    routes = tuple(app_root / path for path in (*S3_ROUTE_FILES, *include_routes))
    missing_routes = [route for route in routes if route not in trees]
    if missing_routes:
        raise SystemExit(f"missing exact route files: {missing_routes}")

    violations: list[str] = []
    for route in routes:
        facts = discover_aliases(trees[route])
        violations.extend(route_violations(trees[route], route, facts))

    for class_name, expected_path in (
        ("SpaceRuntimeHandle", app_root / "runtime/space.py"),
        ("EntityCommand", app_root / "commands/entity.py"),
    ):
        definitions = [
            (app_file, node.lineno)
            for app_file, tree in trees.items()
            for node in ast.walk(tree)
            if isinstance(node, ast.ClassDef) and node.name == class_name
        ]
        if len(definitions) != 1 or definitions[0][0] != expected_path:
            violations.append(
                f"{class_name} authority mismatch: expected {expected_path}, "
                f"got {definitions}"
            )

    read_count = 0
    for app_file, tree in trees.items():
        facts = discover_aliases(tree)
        parents = {
            child: parent
            for parent in ast.walk(tree)
            for child in ast.iter_child_nodes(parent)
        }
        for escape in collect_unknown_relation_escapes(tree, facts, parents):
            violations.append(
                f"{app_file}:{escape.lineno}: unknown SyncOutbox relation escape"
            )
        for read in collect_sync_outbox_reads(tree, facts, parents):
            read_count += 1
            if read.kind == "raw-dynamic":
                violations.append(
                    f"{app_file}:{read.node.lineno}: dynamic raw SQL reader "
                    "cannot be proven not to read SyncOutbox"
                )
                continue
            if read.kind == "raw":
                violations.append(
                    f"{app_file}:{read.node.lineno}: "
                    "raw SQL SyncOutbox read is forbidden"
                )
                continue
            if is_statically_dead(read.node, parents):
                violations.append(
                    f"{app_file}:{read.node.lineno}: "
                    "statically dead SyncOutbox read is forbidden"
                )
                continue
            if read.kind == "direct-get":
                violations.append(
                    f"{app_file}:{read.node.lineno}: "
                    "direct SyncOutbox get cannot enforce visibility"
                )
                continue
            root = chain_root(read.node, parents)
            valid, unsafe_nested = read_has_visible_conjunct(read, root, facts)
            if unsafe_nested:
                violations.append(
                    f"{app_file}:{read.node.lineno}: SyncOutbox visibility "
                    "under OR/NOT/IfExp is forbidden"
                )
            elif not valid:
                violations.append(
                    f"{app_file}:{read.node.lineno}: "
                    "SyncOutbox visible predicate must be a top-level AND conjunct"
                )
    if read_count == 0:
        violations.append("no SyncOutbox read paths found under backend/app")
    if violations:
        raise SystemExit("\n".join(violations))
    return len(trees), len(routes), read_count


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app-root", required=True, type=Path)
    parser.add_argument(
        "--include-route",
        action="append",
        default=[],
        type=Path,
        help="route path relative to --app-root",
    )
    args = parser.parse_args()
    if any(path.is_absolute() or ".." in path.parts for path in args.include_route):
        raise SystemExit("--include-route must stay relative to --app-root")
    app_files, routes, reads = run_gate(
        args.app_root, tuple(args.include_route)
    )
    print(
        f"AUTHORITY_GATE_OK app_files={app_files} routes={routes} "
        f"sync_outbox_reads={reads}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
