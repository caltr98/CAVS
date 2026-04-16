#!/usr/bin/env python3
"""
Compute and print a correlation matrix for selected columns in the augmented LIAR dataset.

By default uses FDHN/dataset/train_augmented.csv and includes:
- label
- label_bin (label>=2 -> 1 else 0)
- skills_gpt_competent
- confidence_gpt
- true_counts, mostly_true_counts, half_true_counts, mostly_false_counts, false_counts, pants_on_fire_counts

You can adjust the path or columns below as needed.
"""

import argparse
import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--csv",
        default="/home/cal/componentsCAVS/FDHN/dataset/train_augmented.csv",
        help="Path to augmented CSV.",
    )
    parser.add_argument("--save", default=None, help="Optional path to save the heatmap (e.g., corr.png).")
    args = parser.parse_args()

    df = pd.read_csv(args.csv)
    # Binary target: label>=2 -> 1 else 0
    df["label_bin"] = df["label"].apply(lambda x: 1 if int(x) >= 2 else 0)

    # Correlate only numeric/binary columns (text columns are not meaningful for Pearson)
    cols = [
        "label_bin",
        "skills_gpt_competent",
        "confidence_gpt",
    ]
    existing = [c for c in cols if c in df.columns]
    corr = df[existing].corr()
    print("Correlation matrix (label_bin, skills_gpt_competent, confidence_gpt):")
    print(corr.to_string(float_format=lambda x: f"{x:0.3f}"))

    plt.figure(figsize=(5, 4))
    sns.heatmap(corr, annot=True, fmt=".2f", cmap="coolwarm", square=True)
    plt.title("Correlation Matrix (Binary Label)")
    plt.tight_layout()
    if args.save:
        plt.savefig(args.save, dpi=300)
        print(f"Saved heatmap to {args.save}")
    else:
        plt.show()


if __name__ == "__main__":
    main()
