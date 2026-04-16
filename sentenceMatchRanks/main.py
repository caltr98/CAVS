from sentence_transformers import SentenceTransformer
import numpy as np

# 1. Load a pretrained Sentence Transformer model
model = SentenceTransformer("all-MiniLM-L6-v2")

# 2. Define input sentences, including hierarchical elements
sentences = [
	"Knowledge",
	"Information and Communication Technologies (ICTs)",
	"Software and Applications Development and Analysis",
	"Web Programming",
	"Mobile Application Development",
	"Software Testing",
	"Networking and Cybersecurity",
	"Cloud Security",
	"Penetration Testing",
	""
]

# 3. Encode sentences into embeddings
embeddings = model.encode(sentences)

# 4. Compute cosine similarity
similarities = np.inner(embeddings, embeddings)

# 5. Print similarity rankings
num_sentences = len(sentences)
rankings = []

for i in range(num_sentences):
	similarity_scores = [(j, similarities[i][j]) for j in range(num_sentences)]
	similarity_scores.sort(key=lambda x: x[1], reverse=True)
	rankings.append([(sentences[j], score) for j, score in similarity_scores])

# 6. Display results
for i, ranked in enumerate(rankings):
	print(f"Ranking for: '{sentences[i]}'")
	for rank, (sentence, score) in enumerate(ranked, 1):
		print(f"  {rank}. '{sentence}' - Similarity: {score:.4f}")
	print()
