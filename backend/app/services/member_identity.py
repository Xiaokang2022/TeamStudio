"""Cross-group person identity (round 7).

A registered account may own one ``members`` row per development group (possibly across
several teams). The rows are linked to the account, not to each other, so aggregate reads
de-duplicate them with the following key (``docs/ROUND7_CONTRACT.md §1``)::

    personKey = lower(external_id)   # account id first
              = lower(email)         # e-mail second
              = "member:<id>"        # standalone archive row fallback

Rows whose ``external_id`` *and* ``email`` are both empty are never merged with each
other; they stay independent people. Rows are expected to arrive already ordered by
``g.sort_order, g.name, m.sort_order, m.created_at, m.id`` (every caller uses that
ordering): the first row of a person is the **primary archive** used for the card's
identity fields, and the incoming order of the merged groups is preserved.

Rows of the same account may use either link style: round-5 demo rows store the e-mail in
``external_id`` while round-6 rows created from a ``users`` account store the account id
there. Two rows are therefore the same person when they share *any* non-empty
``external_id`` / ``email`` alias; the person's canonical key is still computed with
:func:`person_key` from its primary row.
"""

from __future__ import annotations

import sqlite3
from typing import Any, Iterable


def person_key(row: dict[str, Any]) -> str:
    """Stable, case-insensitive person key for one ``members`` row."""
    external_id = str(row.get("external_id") or "").strip().lower()
    if external_id:
        return external_id
    email = str(row.get("email") or "").strip().lower()
    if email:
        return email
    return f"member:{row.get('id', '')}"


def _aliases(row: dict[str, Any]) -> list[str]:
    """Non-empty link identifiers of one row (``external_id`` first, then e-mail)."""
    values: list[str] = []
    for value in (row.get("external_id"), row.get("email")):
        cleaned = str(value or "").strip().lower()
        if cleaned and cleaned not in values:
            values.append(cleaned)
    return values


def group_members(member_rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Merge ``members`` rows into people, preserving the incoming order.

    Returns a list of ``{"personKey", "primary", "rows"}`` entries; the first row of each
    entry is the primary archive (the group ordering decides it).
    """
    ordered = list(member_rows)
    parents = list(range(len(ordered)))

    def find(index: int) -> int:
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    def union(left: int, right: int) -> None:
        left_root, right_root = find(left), find(right)
        if left_root == right_root:
            return
        # The earliest row stays the root so the input order is never disturbed.
        if left_root < right_root:
            parents[right_root] = left_root
        else:
            parents[left_root] = right_root

    alias_owner: dict[str, int] = {}
    for index, member in enumerate(ordered):
        for alias in _aliases(member):
            owner = alias_owner.get(alias)
            if owner is None:
                alias_owner[alias] = index
            else:
                union(index, owner)

    grouped: dict[int, list[dict[str, Any]]] = {}
    for index, member in enumerate(ordered):
        grouped.setdefault(find(index), []).append(member)
    return [
        {
            "personKey": person_key(rows[0]),
            "primary": rows[0],
            "rows": rows,
        }
        for rows in grouped.values()
    ]


# Alias kept for readability at call sites that only care about the merge result.
merge_member_rows = group_members


def member_ids(person: dict[str, Any]) -> list[str]:
    """Every archive id of one merged person, in group order."""
    return [str(row.get("id", "")) for row in person["rows"]]


def membership_payload(member: dict[str, Any]) -> dict[str, Any]:
    """One ``memberships[]`` row (member archive inside its development group)."""
    return {
        "memberId": member.get("id", ""),
        "groupId": member.get("group_id", ""),
        "groupName": member.get("group_name", ""),
        "teamId": member.get("group_team_id") or member.get("team_id", ""),
        "teamName": member.get("team_name", ""),
        "title": member.get("title", ""),
        "role": member.get("role", ""),
        "status": member.get("status", "available"),
        "joinedAt": member.get("joined_at", ""),
    }


def memberships(person: dict[str, Any]) -> list[dict[str, Any]]:
    """Every membership of one merged person, in group order."""
    return [membership_payload(row) for row in person["rows"]]


def group_names_and_ids(
    person: dict[str, Any],
) -> tuple[list[str], list[str], list[str], list[str]]:
    """Deduplicated ``(groupIds, groupNames, teamIds, teamNames)`` in occurrence order."""
    group_ids: list[str] = []
    group_names: list[str] = []
    team_ids: list[str] = []
    team_names: list[str] = []
    for member in person["rows"]:
        group_id = str(member.get("group_id") or "")
        if group_id and group_id not in group_ids:
            group_ids.append(group_id)
        group_name = str(member.get("group_name") or "")
        if group_name and group_name not in group_names:
            group_names.append(group_name)
        team_id = str(member.get("group_team_id") or member.get("team_id") or "")
        if team_id and team_id not in team_ids:
            team_ids.append(team_id)
        team_name = str(member.get("team_name") or "")
        if team_name and team_name not in team_names:
            team_names.append(team_name)
    return group_ids, group_names, team_ids, team_names


def identity_fields(person: dict[str, Any]) -> dict[str, Any]:
    """The additive read-payload fields shared by overview members and workloads."""
    group_ids, group_names, team_ids, team_names = group_names_and_ids(person)
    return {
        "memberIds": member_ids(person),
        "memberships": memberships(person),
        "groupIds": group_ids,
        "groupNames": group_names,
        "teamIds": team_ids,
        "teamNames": team_names,
    }


def deduped_count(member_rows: Iterable[dict[str, Any]]) -> int:
    """Number of distinct people in a list of archive rows (empty rows ignored)."""
    return len({person_key(row) for row in member_rows})


def first_member_in_group(
    conn: sqlite3.Connection, group_id: str, member_ids: Iterable[str]
) -> dict[str, Any] | None:
    """The caller-owned archive row inside ``group_id`` (path/active group), if any.

    Used for write defaults: creating a task/todo without ``memberId`` targets the
    caller's row in the request's development group, never another group's row.
    """
    ids = [str(item) for item in member_ids if item]
    if not ids:
        return None
    placeholders = ",".join("?" for _ in ids)
    found = conn.execute(
        "SELECT id, name FROM members WHERE group_id=? "
        f"AND id IN ({placeholders}) "
        "ORDER BY sort_order, created_at, id LIMIT 1",
        (group_id, *ids),
    ).fetchone()
    return dict(found) if found else None

