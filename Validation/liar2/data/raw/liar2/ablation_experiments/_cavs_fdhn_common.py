#!/usr/bin/env python3
"""
Shared FDHN-style runner for Validation LIAR2 CAVS ablations.

The original LIAR2 ablation scripts in this folder are preserved as one-file
entry points. This module provides the same "numbered script" surface for the
new competence-feature ablations without duplicating the training loop across
many files.
"""

from __future__ import annotations

import argparse
import copy
import random
import statistics
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

try:
    import numpy as np
    import pandas as pd
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
    import torch.utils.data as data
    from sklearn.metrics import f1_score, mean_squared_error
    from transformers import BertTokenizer
except ModuleNotFoundError as exc:  # pragma: no cover
    raise SystemExit(
        "Missing dependency for LIAR2 CAVS ablations. Install pandas, numpy, "
        "torch, scikit-learn, and transformers in the environment used to run "
        "these scripts."
    ) from exc


DEFAULT_SEEDS = [42, 43, 44, 45, 46]
LABEL_CONVERT = {
    "pants-fire": 0,
    "false": 1,
    "barely-true": 2,
    "half-true": 3,
    "mostly-true": 4,
    "true": 5,
}


def locate_validation_liar2_root() -> Path:
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "data" / "final" / "ablation").exists() and (parent / "data" / "raw" / "liar2").exists():
            return parent
    raise RuntimeError("Could not locate Validation/liar2 root from _cavs_fdhn_common.py.")


LIAR2_ROOT = locate_validation_liar2_root()
CANONICAL_DATASET_DIRS = {
    "gpt_competent_classifier": LIAR2_ROOT / "data" / "final" / "ablation" / "gpt_competent_classifier",
    "roberta_nesta": LIAR2_ROOT / "data" / "final" / "ablation" / "roberta_nesta",
}
CHECKPOINT_DIR = Path(__file__).resolve().parent / "checkpoints"


@dataclass(frozen=True)
class ExperimentConfig:
    model_name: str
    family: str
    task: str
    use_skills: bool
    use_confidence: bool
    use_reason: bool


@dataclass
class Metrics:
    loss: float
    acc: float
    rmse: float
    f1: float | None = None
    f1_macro: float | None = None
    f1_micro: float | None = None


class CAVSDataset(data.Dataset):
    def __init__(
        self,
        statements: torch.Tensor,
        labels: torch.Tensor,
        numeric_features: torch.Tensor,
        reasons: torch.Tensor,
    ) -> None:
        self.statements = statements
        self.labels = labels
        self.numeric_features = numeric_features
        self.reasons = reasons

    def __len__(self) -> int:
        return len(self.labels)

    def __getitem__(self, idx: int):
        return (
            self.statements[idx],
            self.labels[idx],
            self.numeric_features[idx],
            self.reasons[idx],
        )


class FuzzyLayer(nn.Module):
    def __init__(self, input_dim: int, membership_num: int) -> None:
        super().__init__()
        self.input_dim = input_dim
        self.membership_num = membership_num
        self.membership_miu = nn.Parameter(torch.empty(self.membership_num, self.input_dim), requires_grad=True)
        self.membership_sigma = nn.Parameter(torch.empty(self.membership_num, self.input_dim), requires_grad=True)
        nn.init.xavier_uniform_(self.membership_miu)
        nn.init.ones_(self.membership_sigma)

    def forward(self, input_seq: torch.Tensor) -> torch.Tensor:
        batch_size = input_seq.size(0)
        input_seq_exp = input_seq.unsqueeze(1).expand(batch_size, self.membership_num, self.input_dim)
        membership_miu_exp = self.membership_miu.unsqueeze(0).expand(batch_size, self.membership_num, self.input_dim)
        membership_sigma_exp = self.membership_sigma.unsqueeze(0).expand(batch_size, self.membership_num, self.input_dim)
        return torch.mean(
            torch.exp((-0.5) * ((input_seq_exp - membership_miu_exp) / membership_sigma_exp) ** 2),
            dim=-1,
        )


class TextCNN(nn.Module):
    def __init__(
        self,
        vocab_size: int,
        embedding_dim: int,
        n_filters: int,
        filter_sizes: Sequence[int],
        output_dim: int,
        dropout: float,
        pad_idx: int,
    ) -> None:
        super().__init__()
        self.embedding = nn.Embedding(vocab_size, embedding_dim, padding_idx=pad_idx)
        self.convs = nn.ModuleList(
            [
                nn.Conv1d(
                    in_channels=embedding_dim,
                    out_channels=n_filters,
                    kernel_size=fs,
                )
                for fs in filter_sizes
            ]
        )
        self.fc = nn.Linear(len(filter_sizes) * n_filters, output_dim)
        self.dropout = nn.Dropout(dropout)

    def forward(self, text: torch.Tensor) -> torch.Tensor:
        embedded = self.embedding(text)
        embedded = embedded.permute(0, 2, 1)
        conved = [F.relu(conv(embedded)) for conv in self.convs]
        pooled = [F.max_pool1d(conv, conv.shape[2]).squeeze(2) for conv in conved]
        cat = self.dropout(torch.cat(pooled, dim=1))
        return self.fc(cat)


class NumericEncoder(nn.Module):
    def __init__(
        self,
        input_dim: int,
        embedding_dim: int,
        hidden_dim: int,
        output_dim: int,
        n_layers: int,
        bidirectional: bool,
        dropout: float,
    ) -> None:
        super().__init__()
        self.embedding = nn.Linear(input_dim, embedding_dim)
        self.conv = nn.Conv1d(in_channels=1, out_channels=32, kernel_size=1)
        self.rnn = nn.LSTM(
            32,
            hidden_dim,
            num_layers=n_layers,
            bidirectional=bidirectional,
            dropout=dropout if n_layers > 1 else 0.0,
            batch_first=True,
        )
        rnn_out_dim = hidden_dim * 2 if bidirectional else hidden_dim
        self.fc = nn.Linear(rnn_out_dim, output_dim)
        self.dropout = nn.Dropout(dropout)

    def forward(self, metadata: torch.Tensor) -> torch.Tensor:
        embedded = self.dropout(self.embedding(metadata))
        conved = F.relu(self.conv(embedded.unsqueeze(1)))
        conved = conved.transpose(1, 2)
        _, (hidden, _) = self.rnn(conved)
        if self.rnn.bidirectional:
            hidden_out = torch.cat((hidden[-2], hidden[-1]), dim=1)
        else:
            hidden_out = hidden[-1]
        return self.fc(self.dropout(hidden_out))


class LiarCAVSModel(nn.Module):
    def __init__(
        self,
        *,
        vocab_size: int,
        embedding_dim: int,
        n_filters: int,
        filter_sizes: Sequence[int],
        output_dim: int,
        dropout: float,
        padding_idx: int,
        numeric_input_dim: int,
        hidden_dim: int,
        n_layers: int,
        bidirectional: bool,
        use_numeric: bool,
        use_reason: bool,
    ) -> None:
        super().__init__()
        self.use_numeric = use_numeric
        self.use_reason = use_reason
        self.statement_cnn = TextCNN(vocab_size, embedding_dim, n_filters, filter_sizes, output_dim, dropout, padding_idx)
        if self.use_reason:
            self.reason_cnn = TextCNN(vocab_size, embedding_dim, n_filters, filter_sizes, output_dim, dropout, padding_idx)
        if self.use_numeric:
            self.numeric_encoder = NumericEncoder(
                numeric_input_dim,
                embedding_dim,
                hidden_dim,
                output_dim,
                n_layers,
                bidirectional,
                dropout,
            )
            self.fuzzy = FuzzyLayer(output_dim, output_dim)

        branch_count = 1
        if self.use_numeric:
            branch_count += 2
        if self.use_reason:
            branch_count += 1
        self.fuse = nn.Linear(output_dim * branch_count, output_dim)

    def forward(self, statement: torch.Tensor, numeric_features: torch.Tensor, reason: torch.Tensor) -> torch.Tensor:
        branches = [self.statement_cnn(statement)]
        if self.use_numeric:
            numeric_output = self.numeric_encoder(numeric_features)
            branches.append(numeric_output)
            branches.append(self.fuzzy(numeric_output))
        if self.use_reason:
            branches.append(self.reason_cnn(reason))
        return self.fuse(torch.cat(branches, dim=1))


def collapse_ws(value: object) -> str:
    return " ".join(str(value or "").split()).strip()


def parse_bool(value: object) -> float:
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    text = str(value or "").strip().lower()
    if text in {"true", "1", "yes"}:
        return 1.0
    if text in {"false", "0", "no"}:
        return 0.0
    return 0.0


def label_to_binary(label: object) -> int:
    # True-news = half-true or better; barely-true is grouped with false-news,
    # matching the paper's Table 1 base rates.
    return 1 if int(label) >= 3 else 0


def parse_seeds(seed: int | None, raw_seeds: str | None) -> list[int]:
    if seed is not None:
        return [int(seed)]
    if raw_seeds:
        seeds = [int(item.strip()) for item in raw_seeds.split(",") if item.strip()]
        if not seeds:
            raise argparse.ArgumentTypeError("At least one seed is required.")
        return seeds
    return list(DEFAULT_SEEDS)


def feature_slug(config: ExperimentConfig) -> str:
    parts = ["statement"]
    if config.use_skills:
        parts.append("iscompetent")
    if config.use_confidence:
        parts.append("confidence")
    if config.use_reason:
        parts.append("reason")
    return "+".join(parts)


def tokenize_texts(tokenizer: BertTokenizer, values: Iterable[object]) -> torch.Tensor:
    texts = [collapse_ws(value) or "NaN" for value in values]
    tokens = tokenizer(texts, truncation=True, padding=True)
    return torch.tensor(tokens["input_ids"], dtype=torch.long)


def build_numeric_matrix(df: pd.DataFrame, config: ExperimentConfig) -> torch.Tensor:
    cols = []
    if config.use_skills:
        cols.append(df["skills_gpt_competent"].apply(parse_bool).astype(np.float32).to_numpy())
    if config.use_confidence:
        cols.append(pd.to_numeric(df["confidence_gpt"], errors="coerce").fillna(0.0).astype(np.float32).to_numpy())
    if not cols:
        return torch.zeros((len(df), 1), dtype=torch.float32)
    matrix = np.column_stack(cols)
    return torch.tensor(matrix, dtype=torch.float32)


def build_label_tensor(df: pd.DataFrame, task: str) -> torch.Tensor:
    if task == "binary":
        labels = [label_to_binary(value) for value in df["label"]]
    else:
        labels = [int(value) for value in df["label"]]
    return torch.tensor(labels, dtype=torch.long)


def compute_metrics(
    labels_all: list[int],
    preds_all: list[int],
    loss_total: float,
    loader_len: int,
    task: str,
) -> Metrics:
    mse = mean_squared_error(labels_all, preds_all)
    common = {
        "loss": loss_total / max(loader_len, 1),
        "acc": float(np.mean(np.array(labels_all) == np.array(preds_all))),
        "rmse": float(np.sqrt(mse)),
    }
    if task == "binary":
        return Metrics(
            **common,
            f1=f1_score(labels_all, preds_all),
        )
    return Metrics(
        **common,
        f1_macro=f1_score(labels_all, preds_all, average="macro"),
        f1_micro=f1_score(labels_all, preds_all, average="micro"),
    )


def set_seed(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def load_split_df(dataset_dir: Path, split: str) -> pd.DataFrame:
    path = dataset_dir / f"{split}_augmented.csv"
    if not path.exists():
        raise FileNotFoundError(f"Missing dataset split: {path}")
    df = pd.read_csv(path)
    df = df.fillna({"statement": "NaN", "gpt_reason": "NaN"})
    return df


def build_datasets(dataset_dir: Path, config: ExperimentConfig) -> tuple[CAVSDataset, CAVSDataset, CAVSDataset]:
    tokenizer = BertTokenizer.from_pretrained("bert-base-uncased")

    datasets = []
    for split in ("train", "valid", "test"):
        df = load_split_df(dataset_dir, split)
        statements = tokenize_texts(tokenizer, df["statement"])
        labels = build_label_tensor(df, config.task)
        numeric = build_numeric_matrix(df, config)
        reasons = tokenize_texts(tokenizer, df["gpt_reason"]) if config.use_reason else torch.zeros((len(df), 1), dtype=torch.long)
        datasets.append(CAVSDataset(statements, labels, numeric, reasons))
    return tuple(datasets)  # type: ignore[return-value]


def format_metrics(prefix: str, metrics: Metrics) -> str:
    if metrics.f1 is not None and metrics.f1_macro is None and metrics.f1_micro is None:
        return (
            f"{prefix} Loss: {metrics.loss:.4f}, {prefix} Acc: {metrics.acc:.4f}, "
            f"{prefix} F1: {metrics.f1:.4f}, {prefix} RMSE: {metrics.rmse:.4f}"
        )
    return (
        f"{prefix} Loss: {metrics.loss:.4f}, {prefix} Acc: {metrics.acc:.4f}, "
        f"{prefix} F1 Macro: {metrics.f1_macro:.4f}, {prefix} F1 Micro: {metrics.f1_micro:.4f}, "
        f"{prefix} RMSE: {metrics.rmse:.4f}"
    )


def evaluate(
    model: nn.Module,
    loader: data.DataLoader,
    criterion: nn.Module,
    device: torch.device,
    task: str,
) -> Metrics:
    model.eval()
    loss_total = 0.0
    labels_all: list[int] = []
    preds_all: list[int] = []

    with torch.no_grad():
        for statements, labels, numeric_features, reasons in loader:
            statements = statements.to(device)
            labels = labels.to(device)
            numeric_features = numeric_features.to(device)
            reasons = reasons.to(device)

            outputs = model(statements, numeric_features, reasons)
            loss = criterion(outputs, labels)
            loss_total += loss.item()
            preds = outputs.argmax(dim=1)
            labels_all.extend(labels.tolist())
            preds_all.extend(preds.tolist())

    return compute_metrics(labels_all, preds_all, loss_total, len(loader), task)


def train_one_seed(
    *,
    config: ExperimentConfig,
    train_dataset: CAVSDataset,
    val_dataset: CAVSDataset,
    test_dataset: CAVSDataset,
    seed: int,
    epochs: int,
    batch_size: int,
    learning_rate: float,
    device: torch.device,
    checkpoint_path: Path,
) -> tuple[Metrics, Metrics]:
    set_seed(seed)
    torch.backends.cudnn.deterministic = True
    torch.backends.cudnn.benchmark = False

    train_generator = torch.Generator()
    train_generator.manual_seed(seed)
    train_loader = data.DataLoader(train_dataset, batch_size=batch_size, shuffle=True, generator=train_generator)
    val_loader = data.DataLoader(val_dataset, batch_size=batch_size)
    test_loader = data.DataLoader(test_dataset, batch_size=batch_size)

    output_dim = 2 if config.task == "binary" else 6
    numeric_input_dim = train_dataset.numeric_features.shape[1]
    use_numeric = config.use_skills or config.use_confidence

    model = LiarCAVSModel(
        vocab_size=30522,
        embedding_dim=128,
        n_filters=128,
        filter_sizes=[3, 4, 5],
        output_dim=output_dim,
        dropout=0.5,
        padding_idx=0,
        numeric_input_dim=numeric_input_dim,
        hidden_dim=64,
        n_layers=1,
        bidirectional=True,
        use_numeric=use_numeric,
        use_reason=config.use_reason,
    ).to(device)

    optimizer = torch.optim.Adam(model.parameters(), lr=learning_rate)
    criterion = nn.CrossEntropyLoss()

    best_valid_loss = float("inf")
    best_state: dict[str, torch.Tensor] | None = None

    start_time = time.time()
    for epoch in range(epochs):
        epoch_start = time.time()
        model.train()
        train_loss = 0.0
        labels_all: list[int] = []
        preds_all: list[int] = []

        for statements, labels, numeric_features, reasons in train_loader:
            statements = statements.to(device)
            labels = labels.to(device)
            numeric_features = numeric_features.to(device)
            reasons = reasons.to(device)

            optimizer.zero_grad()
            outputs = model(statements, numeric_features, reasons)
            loss = criterion(outputs, labels)
            loss.backward()
            optimizer.step()

            train_loss += loss.item()
            preds = outputs.argmax(dim=1)
            labels_all.extend(labels.tolist())
            preds_all.extend(preds.tolist())

        train_metrics = compute_metrics(labels_all, preds_all, train_loss, len(train_loader), config.task)
        val_metrics = evaluate(model, val_loader, criterion, device, config.task)
        test_metrics = evaluate(model, test_loader, criterion, device, config.task)

        if val_metrics.loss < best_valid_loss:
            best_valid_loss = val_metrics.loss
            best_state = copy.deepcopy(model.state_dict())
            checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
            torch.save(best_state, checkpoint_path)
            print(f"***** Best Result Updated at Epoch {epoch + 1}, Val Loss: {val_metrics.loss:.4f} *****")

        epoch_time = time.time() - epoch_start
        print(
            f"Epoch [{epoch + 1}/{epochs}], Time: {epoch_time:.2f}s, \n"
            f"{format_metrics('Train', train_metrics)}, \n"
            f"{format_metrics('Val', val_metrics)}, \n"
            f"{format_metrics('Test', test_metrics)}\n"
        )

    total_time = time.time() - start_time
    print(f"Total Training Time: {total_time:.2f}s")

    if best_state is None:
        raise RuntimeError("Training completed without a saved model.")

    model.load_state_dict(torch.load(checkpoint_path, map_location=device))
    final_val_metrics = evaluate(model, val_loader, criterion, device, config.task)
    final_test_metrics = evaluate(model, test_loader, criterion, device, config.task)
    print(f"\n{format_metrics('Val', final_val_metrics)}")
    print(f"{format_metrics('Test', final_test_metrics)}")
    return final_val_metrics, final_test_metrics


def choose_device(raw: str | None) -> torch.device:
    if raw:
        return torch.device(raw)
    return torch.device("cuda") if torch.cuda.is_available() else torch.device("cpu")


def parse_args(config: ExperimentConfig, argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=f"{config.model_name}: statement/{feature_slug(config)} LIAR2 CAVS ablation."
    )
    parser.add_argument(
        "--dataset-dir",
        type=Path,
        default=CANONICAL_DATASET_DIRS[config.family],
        help="Augmented LIAR2 dataset directory containing train/valid/test_augmented.csv.",
    )
    parser.add_argument("--epochs", type=int, default=20, help="Training epochs.")
    parser.add_argument("--batch-size", type=int, default=32, help="Batch size.")
    parser.add_argument("--learning-rate", type=float, default=1e-3, help="Adam learning rate.")
    parser.add_argument("--seed", type=int, default=None, help="Run exactly one seed instead of the default seed list.")
    parser.add_argument(
        "--seeds",
        default=",".join(str(seed) for seed in DEFAULT_SEEDS),
        help="Comma-separated seed list for mean/stdev reporting (default: %(default)s).",
    )
    parser.add_argument("--device", default=None, help="Torch device override, e.g. cpu or cuda:0.")
    parser.add_argument(
        "--checkpoint-path",
        type=Path,
        default=None,
        help="Optional checkpoint path. Defaults to <script_name>.pt next to the wrapper script.",
    )
    return parser.parse_args(argv)


def run_named_experiment(config: ExperimentConfig, argv: Sequence[str] | None = None) -> int:
    args = parse_args(config, argv)
    dataset_dir = args.dataset_dir.resolve()
    seeds = parse_seeds(args.seed, args.seeds)
    device = choose_device(args.device)
    default_checkpoint = Path(__file__).resolve().with_name(f"{config.model_name}.pt")
    checkpoint_path = args.checkpoint_path.resolve() if args.checkpoint_path else default_checkpoint

    print(f"PyTorch Version : {torch.__version__}")
    print(device)
    print(checkpoint_path.name)

    train_dataset, val_dataset, test_dataset = build_datasets(dataset_dir, config)
    val_metrics_all: list[Metrics] = []
    test_metrics_all: list[Metrics] = []

    for seed in seeds:
        run_checkpoint_path = (
            checkpoint_path.with_name(f"{checkpoint_path.stem}.seed{seed}{checkpoint_path.suffix}")
            if len(seeds) > 1
            else checkpoint_path
        )
        print(f"\n=== Run seed={seed} ===")
        print(run_checkpoint_path.name)
        val_metrics, test_metrics = train_one_seed(
            config=config,
            train_dataset=train_dataset,
            val_dataset=val_dataset,
            test_dataset=test_dataset,
            seed=seed,
            epochs=args.epochs,
            batch_size=args.batch_size,
            learning_rate=args.learning_rate,
            device=device,
            checkpoint_path=run_checkpoint_path,
        )
        val_metrics_all.append(val_metrics)
        test_metrics_all.append(test_metrics)

    def mean_std(values: Iterable[float]) -> tuple[float, float]:
        values_list = list(values)
        mean = statistics.mean(values_list)
        std = statistics.stdev(values_list) if len(values_list) > 1 else 0.0
        return mean, std

    def format_mean_std(label: str, values: Iterable[float]) -> str:
        mean, std = mean_std(values)
        return f"{label}: {mean:.4f} ± {std:.4f}"

    print("\nAverage across runs")
    print(f"Seeds: {','.join(str(seed) for seed in seeds)}")
    if config.task == "binary":
        print(
            ", ".join(
                [
                    format_mean_std("Val Loss", (m.loss for m in val_metrics_all)),
                    format_mean_std("Val Acc", (m.acc for m in val_metrics_all)),
                    format_mean_std("Val F1", (m.f1 for m in val_metrics_all if m.f1 is not None)),
                    format_mean_std("Val RMSE", (m.rmse for m in val_metrics_all)),
                ]
            )
        )
        print(
            ", ".join(
                [
                    format_mean_std("Test Loss", (m.loss for m in test_metrics_all)),
                    format_mean_std("Test Acc", (m.acc for m in test_metrics_all)),
                    format_mean_std("Test F1", (m.f1 for m in test_metrics_all if m.f1 is not None)),
                    format_mean_std("Test RMSE", (m.rmse for m in test_metrics_all)),
                ]
            )
        )
    else:
        print(
            ", ".join(
                [
                    format_mean_std("Val Loss", (m.loss for m in val_metrics_all)),
                    format_mean_std("Val Acc", (m.acc for m in val_metrics_all)),
                    format_mean_std("Val F1 Macro", (m.f1_macro for m in val_metrics_all if m.f1_macro is not None)),
                    format_mean_std("Val F1 Micro", (m.f1_micro for m in val_metrics_all if m.f1_micro is not None)),
                    format_mean_std("Val RMSE", (m.rmse for m in val_metrics_all)),
                ]
            )
        )
        print(
            ", ".join(
                [
                    format_mean_std("Test Loss", (m.loss for m in test_metrics_all)),
                    format_mean_std("Test Acc", (m.acc for m in test_metrics_all)),
                    format_mean_std("Test F1 Macro", (m.f1_macro for m in test_metrics_all if m.f1_macro is not None)),
                    format_mean_std("Test F1 Micro", (m.f1_micro for m in test_metrics_all if m.f1_micro is not None)),
                    format_mean_std("Test RMSE", (m.rmse for m in test_metrics_all)),
                ]
            )
        )
    return 0
