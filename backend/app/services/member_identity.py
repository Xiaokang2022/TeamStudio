"""Team-based person identity (round 8).

Round 8 removed development groups: the only organisational unit is the **team**. A
registered account may still own several legacy ``members`` rows inside one team (the
round-8 migration deliberately keeps historical duplicates, see
``docs/ROUND8_CONTRACT.md §1.2``). Read models therefore merge those rows into one person
card using the following key::

    personKey = lower(external_id)   # account id first
              = lower(email)         # e-mail second
              = "member:<id>"        # standalone archive row fallback

Rows whose ``external_id`` *and* ``email`` are both empty are never merged with each
other; they stay independent people. Rows are expected to arrive already ordered by
``m.sort_order, m.created_at, m.id`` (every caller uses that ordering): the first row of a
person is the **primary archive** used for the card's identity fields, and the incoming
order of the merged rows is preserved.

A membership is now ``(member archive, team)``: there are no group fields at all and a
member has no availability ``status`` any more. Rows of the same account may use either
link style (legacy rows store the e-mail in ``external_id`` while rows created from a
``users`` account store the account id there), so two rows are the same person when they
share *any* non-empty ``external_id`` / ``email`` alias.
"""

from __future__ import annotations

import sqlite3
from typing import Any, Iterable

from ..db import rows


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


def team_members(member_rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Merge team-scoped ``members`` rows into people, preserving the incoming order.

    Returns a list of ``{"personKey", "primary", "rows"}`` entries; the first row of each
    entry is the primary archive (the caller's ordering decides it, normally by
    ``sort_order, created_at, id``). Callers pass the rows of one team for the per-team
    overview; the merge itself also works for a cross-team listing (the profile page).
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
            "personKey": person_key(person_rows[0]),
            "primary": person_rows[0],
            "rows": person_rows,
        }
        for person_rows in grouped.values()
    ]


# Backwards-compatible aliases: other feature routers share the merge logic and may still
# import the round-7 name. Both point at the team-based implementation above.
group_members = team_members
merge_member_rows = team_members


def member_ids(person: dict[str, Any]) -> list[str]:
    """Every archive id of one merged person, in team order."""
    return [str(member.get("id", "")) for member in person["rows"]]


def membership_payload(member: dict[str, Any]) -> dict[str, Any]:
    """One ``memberships[]`` row (member archive inside its team) — no group/status."""
    return {
        "memberId": member.get("id", ""),
        "teamId": member.get("team_id", ""),
        "teamName": member.get("team_name", ""),
        "title": member.get("title", ""),
        "role": member.get("role", ""),
        "joinedAt": member.get("joined_at", ""),
    }


def memberships(person: dict[str, Any]) -> list[dict[str, Any]]:
    """Every membership of one merged person, in team order."""
    return [membership_payload(member) for member in person["rows"]]


def team_names_and_ids(
    person: dict[str, Any],
) -> tuple[list[str], list[str]]:
    """Deduplicated ``(teamIds, teamNames)`` in occurrence order."""
    team_ids: list[str] = []
    team_names: list[str] = []
    for member in person["rows"]:
        team_id = str(member.get("team_id") or "")
        if team_id and team_id not in team_ids:
            team_ids.append(team_id)
        team_name = str(member.get("team_name") or "")
        if team_name and team_name not in team_names:
            team_names.append(team_name)
    return team_ids, team_names


def identity_fields(person: dict[str, Any]) -> dict[str, Any]:
    """The additive read-payload fields shared by overview members and workloads."""
    team_ids, team_names = team_names_and_ids(person)
    return {
        "memberIds": member_ids(person),
        "memberships": memberships(person),
        "teamIds": team_ids,
        "teamNames": team_names,
    }


def deduped_count(member_rows: Iterable[dict[str, Any]]) -> int:
    """Number of distinct people in a list of archive rows (empty rows ignored)."""
    return len({person_key(member) for member in member_rows})


# --------------------------------------------------------------------------- avatars
#
# Round 8 requirement #2: every member payload must carry the account's real avatar.
# The source of truth is ``users.avatar``; a member archive without a linked account
# falls back to its own ``members.avatar_url`` (e.g. a standalone profile photo uploaded
# before the account existed). Resolution key: ``lower(email)`` OR ``lower(external_id)``
# matched against ``lower(users.email)`` / ``lower(users.id)`` (contract §5.5).


def account_avatar_map(conn: sqlite3.Connection) -> dict[str, str]:
    """``lower(e-mail)`` / ``lower(user id)`` -> ``users.avatar`` for every account."""
    avatars: dict[str, str] = {}
    for account in rows(conn, "SELECT id, email, avatar FROM users"):
        avatar = str(account.get("avatar") or "")
        for key in (
            str(account.get("id") or "").strip().lower(),
            str(account.get("email") or "").strip().lower(),
        ):
            if key and key not in avatars:
                avatars[key] = avatar
    return avatars


def member_avatar(member: dict[str, Any], avatars: dict[str, str]) -> str:
    """Real avatar URL of one ``members`` row (account avatar first, then its own)."""
    for key in (
        str(member.get("external_id") or "").strip().lower(),
        str(member.get("email") or "").strip().lower(),
    ):
        if not key:
            continue
        account_avatar = avatars.get(key, "")
        if account_avatar:
            return account_avatar
    return str(member.get("avatar_url") or "")


def first_member_in_team(
    conn: sqlite3.Connection, team_id: str, member_ids: Iterable[str]
) -> dict[str, Any] | None:
    """The caller-owned archive row inside ``team_id`` (path/active team), if any.

    Used for write defaults: creating a task/todo without ``memberId`` targets the
    caller's row in the request's team, never another team's row.
    """
    ids = [str(item) for item in member_ids if item]
    if not ids:
        return None
    placeholders = ",".join("?" for _ in ids)
    found = conn.execute(
        "SELECT id, name FROM members WHERE team_id=? "
        f"AND id IN ({placeholders}) "
        "ORDER BY sort_order, created_at, id LIMIT 1",
        (team_id, *ids),
    ).fetchone()
    return dict(found) if found else None


# Round-7 call sites (e.g. bootstrap) may still import the old name; the second argument
# is the team id now that groups are gone.
first_member_in_group = first_member_in_team
