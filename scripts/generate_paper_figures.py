#!/usr/bin/env python3
"""Generate paper figures (architecture + Merkle PoR) into docs/figures/."""

from __future__ import annotations

from pathlib import Path

import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "figures"
OUT.mkdir(parents=True, exist_ok=True)


def _box(ax, xy, w, h, text, fc="#EEF3F8", ec="#1F3A5F"):
    x, y = xy
    patch = FancyBboxPatch(
        (x, y), w, h, boxstyle="round,pad=0.02,rounding_size=0.02",
        linewidth=1.4, edgecolor=ec, facecolor=fc,
    )
    ax.add_patch(patch)
    ax.text(x + w / 2, y + h / 2, text, ha="center", va="center", fontsize=9,
            color="#102A43", wrap=True)


def _arrow(ax, start, end):
    ax.add_patch(
        FancyArrowPatch(
            start, end, arrowstyle="-|>", mutation_scale=12,
            linewidth=1.2, color="#334E68",
        )
    )


def fig_architecture():
    fig, ax = plt.subplots(figsize=(10, 5.2))
    ax.set_xlim(0, 10)
    ax.set_ylim(0, 5.5)
    ax.axis("off")
    ax.set_title("VIN-bound Proof of Repair pipeline", fontsize=13, pad=8, color="#102A43")

    _box(ax, (0.3, 3.6), 1.8, 1.2, "Symptoms\n+ DTC / OBD")
    _box(ax, (2.5, 3.6), 2.0, 1.2, "LoRA LLM\n(TinyLlama /\nMistral-4bit)")
    _box(ax, (4.9, 3.6), 2.0, 1.2, "RepairReport\nJSON")
    _box(ax, (7.3, 3.6), 2.2, 1.2, "Evidence CID\n(local CAS)")

    _box(ax, (1.8, 1.4), 2.6, 1.3, "PoR leaf\nH(VIN‖odo‖report‖\ncid‖model)")
    _box(ax, (4.8, 1.4), 2.2, 1.3, "Merkle batch\nof leaves")
    _box(ax, (7.4, 1.4), 2.2, 1.3, "OTS receipt\n+ EVM root")

    _arrow(ax, (2.1, 4.2), (2.5, 4.2))
    _arrow(ax, (4.5, 4.2), (4.9, 4.2))
    _arrow(ax, (6.9, 4.2), (7.3, 4.2))
    _arrow(ax, (5.9, 3.6), (4.5, 2.7))
    _arrow(ax, (4.4, 2.05), (4.8, 2.05))
    _arrow(ax, (7.0, 2.05), (7.4, 2.05))

    ax.text(5, 0.35,
            "Buyer: verify report hash · leaf · Merkle inclusion · chain/OTS anchor",
            ha="center", fontsize=9, color="#486581")
    fig.tight_layout()
    path = OUT / "fig1_architecture.png"
    fig.savefig(path, dpi=200, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    return path


def fig_merkle():
    fig, ax = plt.subplots(figsize=(8.5, 5))
    ax.set_xlim(0, 8.5)
    ax.set_ylim(0, 5)
    ax.axis("off")
    ax.set_title("Merkle batch of VIN Proof-of-Repair leaves", fontsize=13, pad=8, color="#102A43")

    leaves = [
        (0.4, 0.6, "Leaf0\nVIN A"),
        (2.3, 0.6, "Leaf1\nVIN B"),
        (4.2, 0.6, "Leaf2\nVIN C"),
        (6.1, 0.6, "Leaf3\npad/empty"),
    ]
    for x, y, t in leaves:
        _box(ax, (x, y), 1.6, 1.0, t, fc="#F0F4F8")

    _box(ax, (1.35, 2.2), 1.6, 0.9, "H01", fc="#D9E2EC")
    _box(ax, (5.15, 2.2), 1.6, 0.9, "H23", fc="#D9E2EC")
    _box(ax, (3.25, 3.6), 1.8, 0.95, "Merkle root\n(on-chain)", fc="#BCCCDC")

    _arrow(ax, (1.2, 1.6), (1.8, 2.2))
    _arrow(ax, (3.1, 1.6), (2.5, 2.2))
    _arrow(ax, (5.0, 1.6), (5.6, 2.2))
    _arrow(ax, (6.9, 1.6), (6.3, 2.2))
    _arrow(ax, (2.15, 3.1), (3.6, 3.6))
    _arrow(ax, (5.95, 3.1), (4.7, 3.6))

    fig.tight_layout()
    path = OUT / "fig2_merkle.png"
    fig.savefig(path, dpi=200, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    return path


def fig_results_bars():
    fig, ax = plt.subplots(figsize=(7.2, 4.2))
    models = ["TinyLlama\nLoRA", "Mistral-7B\n4bit LoRA"]
    fault = [0.930, 0.983]
    jsonv = [1.000, 0.983]
    x = range(len(models))
    w = 0.35
    b1 = ax.bar([i - w / 2 for i in x], fault, w, label="Fault-code acc.", color="#243B53")
    b2 = ax.bar([i + w / 2 for i in x], jsonv, w, label="JSON validity", color="#627D98")
    ax.set_ylim(0, 1.15)
    ax.set_xticks(list(x))
    ax.set_xticklabels(models)
    ax.set_ylabel("Score")
    ax.set_title("Real OBD hold-out (n=57, fair, DTC-disjoint)")
    ax.legend(frameon=False)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    for bars in (b1, b2):
        for bar in bars:
            h = bar.get_height()
            ax.text(bar.get_x() + bar.get_width() / 2, h + 0.02, f"{h:.3f}",
                    ha="center", va="bottom", fontsize=8)
    fig.tight_layout()
    path = OUT / "fig3_obd_results.png"
    fig.savefig(path, dpi=200, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    return path


def main():
    paths = [fig_architecture(), fig_merkle(), fig_results_bars()]
    for p in paths:
        print("wrote", p)


if __name__ == "__main__":
    main()
