import json
import numpy as np
from fastembed import TextEmbedding
from pathlib import Path
from collections import Counter

MODEL_NAME = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"

# k-NN classifies only these three fields.
# product → keyword detection (PRODUCT_KEYWORDS) with "other" fallback
# tenant  → keyword detection (TENANT_KEYWORDS)
CLASSIFICATION_FIELDS = ["issue_type", "category", "severity"]

# Keyword maps for product and tenant detection.
# Keys are canonical label values; values are ordered lists of substrings to
# match (most-specific first so longer phrases win over short ones).
PRODUCT_KEYWORDS = {
    "connect": ["app connect", "connect"],
    "dashboard": ["app dashboard", "dashboard"],
    "app": ["mobile app"],
}

TENANT_KEYWORDS = {
    "Tenant A": ["tenant_a"],
    "Tenant B": ["tenant_b"],
}

K = 3  # number of neighbors for k-NN voting (small dataset: fewer neighbors = less noise)


def _match_keywords(msg_lower: str, keyword_map: dict) -> str | None:
    """Return the first label whose keywords appear in msg_lower, else None."""
    for label, keywords in keyword_map.items():
        for kw in keywords:
            if kw in msg_lower:
                return label
    return None


class Classifier:
    def __init__(self):
        self.model = TextEmbedding(MODEL_NAME, threads=1, enable_cpu_mem_arena=False)

        examples_path = Path(__file__).parent / "examples.json"
        with open(examples_path, encoding="utf-8") as f:
            self.examples = json.load(f)

        # Pre-compute embeddings for all example texts (normalized for cosine similarity)
        texts = [ex["text"] for ex in self.examples]
        raw = np.array(list(self.model.embed(texts)))
        norms = np.linalg.norm(raw, axis=1, keepdims=True)
        self.embeddings = raw / np.where(norms == 0, 1, norms)

    def classify(self, message: str) -> dict:
        # Embed the input message (normalized for cosine similarity)
        raw_msg = np.array(list(self.model.embed([message])))[0]
        norm = np.linalg.norm(raw_msg)
        msg_embedding = raw_msg / norm if norm > 0 else raw_msg

        # Cosine similarity (both sides are unit vectors)
        similarities = self.embeddings @ msg_embedding

        # Top-k nearest neighbors
        k = min(K, len(self.examples))
        top_k_idx = np.argsort(similarities)[-k:][::-1]
        top_k_sims = similarities[top_k_idx]

        result = {}
        for field in CLASSIFICATION_FIELDS:
            # Weighted voting among top-k neighbors
            votes = Counter()
            for idx, sim in zip(top_k_idx, top_k_sims):
                label = self.examples[idx].get(field)
                if label:
                    votes[label] += float(sim)

            if votes:
                winner, winner_weight = votes.most_common(1)[0]
                total_weight = sum(votes.values())
                agreement = winner_weight / total_weight
                # Use top-1 similarity so confidence reflects the best-match quality,
                # not the average quality of all k neighbors (which may include far ones)
                top_similarity = float(top_k_sims[0])
                confidence = round(agreement * top_similarity, 3)
                result[field] = winner
                result[f"{field}_confidence"] = confidence
            else:
                result[field] = None
                result[f"{field}_confidence"] = 0

        # Keyword detection for product and tenant (not handled by k-NN).
        # product: exact names win over short aliases; falls back to "other".
        # tenant: English names + Thai variants (surin / สุรินทร์).
        msg_lower = message.lower()

        product_match = _match_keywords(msg_lower, PRODUCT_KEYWORDS)
        result["product"] = product_match if product_match else "other"
        result["product_confidence"] = 1.0 if product_match else 0.0

        tenant_match = _match_keywords(msg_lower, TENANT_KEYWORDS)
        result["tenant"] = tenant_match
        result["tenant_confidence"] = 1.0 if tenant_match else 0.0

        # Summary: first 80 chars of the message
        result["summary"] = message[:80].strip()

        return result
