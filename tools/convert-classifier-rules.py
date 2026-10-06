#!/usr/bin/env python3
"""Convert the MIT-licensed classifier sources into src/core/classifier/rules.json.

Sources (both MIT, see THIRD_PARTY_NOTICES.md):
  - tayayan/HiraganaSuisho tac_match.py (c) 2023 tayayan
  - mizar/sylwi-kifu-vue src/assets/castle/castle.yaml (c) 2020 Mizar

Usage: python3 tools/convert-classifier-rules.py <tac_match.py> <castle.yaml> <out.json>

Rule expressions:
  {"all": "<sfen board>[ <hand>]"}   every piece in the template is on the board (hand counts exact)
  {"any": "<sfen board>"}            at least one template piece is on the board
  {"and": [...]}, {"or": [...]}, {"not": e}
All templates are from black's view; the matcher rotates the board for white.
"""
import ast
import json
import sys

import yaml

GROUPS = {
    "enc_match": ("castle", "self"),
    "bt_match1": ("opening", "absolute"),
    "bt_match2": ("opening_side", "self"),
    "sente_tac_match": ("tactic_black", "absolute"),
    "gote_tac_match": ("tactic_white", "absolute"),
    "tac_match": ("tactic", "self"),
}

# Plies after which a rule group no longer fires (stops late-game false positives).
PLY_MAX = {"opening": 40, "opening_side": 40, "tactic_black": 60, "tactic_white": 60, "tactic": 60}

# Known bugs in the source (see research/classifiers.md).
DROP = {
    ("bt_match2", "嬉野流"),  # same template as 鬼殺し, which always wins; replaced from mizar below
    ("gote_tac_match", "相掛かり横歩取らせ"),  # same template as 6二金・8一飛車型
}


def template(call):
    fn = call.func.id
    sfen = call.args[1].value
    parts = sfen.split()
    assert parts[0] == "sfen", sfen
    board, hand = parts[1], parts[3]
    t = board if hand == "-" else f"{board} {hand}"
    return {"all": t} if fn == "tac_andmatch" else {"any": t}


def expr(node):
    if isinstance(node, ast.BoolOp):
        key = "and" if isinstance(node.op, ast.And) else "or"
        return {key: [expr(v) for v in node.values]}
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
        return {"not": expr(node.operand)}
    if isinstance(node, ast.Call):
        return template(node)
    raise ValueError(ast.dump(node))


def label_of(body):
    for stmt in body:
        if isinstance(stmt, ast.Return):
            return stmt.value.value
        if isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Call):
            # s.add("...")
            return stmt.value.args[0].value
    raise ValueError("no label")


def walk_if(fn_name, node, out):
    out.append((expr(node.test), label_of(node.body)))
    if node.orelse and len(node.orelse) == 1 and isinstance(node.orelse[0], ast.If):
        walk_if(fn_name, node.orelse[0], out)


def convert_tayayan(path):
    tree = ast.parse(open(path, encoding="utf-8").read())
    rules = []
    for fn in tree.body:
        if not isinstance(fn, ast.FunctionDef) or fn.name not in GROUPS:
            continue
        group, view = GROUPS[fn.name]
        found = []
        for stmt in fn.body:
            if isinstance(stmt, ast.If):
                walk_if(fn.name, stmt, found)
        for i, (e, name) in enumerate(found):
            if (fn.name, name) in DROP:
                continue
            r = {"name": name, "group": group, "view": view, "priority": i, "expr": e, "source": "tayayan"}
            if group in PLY_MAX:
                r["plyMax"] = PLY_MAX[group]
            rules.append(r)
    return rules


FILES = "987654321"  # sfen column order
RANKS = "abcdefghi"


def mizar_pieces_to_expr(pieces):
    """['K*2h', 'S*3h', '_*4h'] -> {"all": sfen}, plus {"not": {"any": ...}} for empty squares."""
    grid = [["" for _ in range(9)] for _ in range(9)]
    empties = [["" for _ in range(9)] for _ in range(9)]
    for p in pieces:
        piece, sq = p.split("*")
        col = FILES.index(sq[0])
        row = RANKS.index(sq[1])
        if piece == "_":
            # "must be empty": encode as NOT any piece of any kind there, handled by "empty" key
            empties[row][col] = "x"
        else:
            grid[row][col] = piece
    def to_sfen(g):
        rows = []
        for r in g:
            s, n = "", 0
            for c in r:
                if c:
                    if n:
                        s += str(n)
                        n = 0
                    s += c
                else:
                    n += 1
            if n:
                s += str(n)
            rows.append(s)
        return "/".join(rows)
    e = {"all": to_sfen(grid)}
    if any(any(r) for r in empties):
        e = {"and": [e, {"empty": to_sfen([["E" if c else "" for c in r] for r in empties])}]}
    return e


# mizar entries worth adding (tayayan lacks them). Castles only use `pieces`.
MIZAR_PICK_CASTLES = {
    "片矢倉", "兜矢倉", "流れ矢倉", "四角金矢倉", "四角銀矢倉", "流線矢倉", "凹み矢倉",
    "金多伝", "銀多伝", "セメント囲い", "米長玉", "ツノ銀雁木", "二枚銀雁木",
    "矢倉穴熊", "完全穴熊", "銀冠穴熊", "天守閣美濃", "右矢倉",
    "風車", "串カツ囲い", "舟囲い", "箱入り娘", "金矢倉", "銀立ち矢倉",
    "左美濃", "居飛車穴熊", "振り飛車穴熊", "松尾流穴熊",
}


def convert_mizar(path, existing_castles):
    data = yaml.safe_load(open(path, encoding="utf-8"))
    rules = []
    seen = set()
    for e in data:
        name = e.get("name", {}).get("ja_JP", "")
        if e.get("hide") or not name or name in seen:
            continue
        if e["id"] in ("URESHINO", "SHIN_URESHINO"):
            seen.add(name)
            rules.append({
                "name": name, "group": "opening_side", "view": "self", "priority": 100,
                "expr": mizar_pieces_to_expr(e["pieces"]), "plyMax": e.get("tesuu_max", 64) + 2,
                "source": "mizar",
            })
            continue
        if name in existing_castles or name not in MIZAR_PICK_CASTLES:
            continue
        if not e.get("pieces") or any(k in e for k in ("moves", "tags_required", "hand")):
            continue
        seen.add(name)
        rules.append({
            "name": name, "group": "castle", "view": "self", "priority": 1000 + len(rules),
            "expr": mizar_pieces_to_expr(e["pieces"]), "source": "mizar",
        })
    return rules


def main():
    tac, yml, out = sys.argv[1:4]
    rules = convert_tayayan(tac)
    castles = {r["name"] for r in rules if r["group"] == "castle"}
    mizar = convert_mizar(yml, castles)
    prio = {r["name"]: r["priority"] for r in rules if r["group"] == "castle"}
    for r in mizar:
        # Specific variants must be tried before tayayan's generic entries (first hit wins).
        if r["group"] != "castle":
            continue
        if "矢倉" in r["name"] and "穴熊" not in r["name"]:
            r["priority"] = prio["矢倉"] - 0.5
        elif "穴熊" in r["name"]:
            r["priority"] = prio["居飛車穴熊"] - 0.5
        elif "雁木" in r["name"]:
            r["priority"] = prio["雁木"] - 0.5
    rules += mizar
    for i, r in enumerate(rules):
        r["id"] = f"{r['group']}:{r['name']}"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(rules, f, ensure_ascii=False, indent=1)
    by = {}
    for r in rules:
        by[r["group"]] = by.get(r["group"], 0) + 1
    print(len(rules), by)


if __name__ == "__main__":
    main()
