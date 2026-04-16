from flask import Flask, request, jsonify
import hashlib
import torch
import io
from keybert import KeyBERT
import time
import statistics  # Import statistics module

# Declare checksum as a global variable
checksum = None
kw_model = None

app = Flask(__name__)


@app.route('/keywords', methods=['GET'])
def get_keywords():
	global checksum, kw_model  # Ensure we're accessing the global variables

	# Get request doc from args
	request_data = request.args

	# Check if 'doc' key exists in the request data
	if 'doc' not in request_data:
		return jsonify(error="Document not provided"), 400

	# Extract the document text from the request data
	doc = request_data['doc']

	# Parse tunable parameters
	try:
		top_n = int(request_data.get('top_n', 50))
	except ValueError:
		top_n = 50
	top_n = max(1, min(top_n, 200))

	try:
		nr_candidates = int(request_data.get('nr_candidates', 100))
	except ValueError:
		nr_candidates = 100
	nr_candidates = max(10, min(nr_candidates, 500))

	try:
		ngram_max = int(request_data.get('ngram_max', 2))
	except ValueError:
		ngram_max = 2
	ngram_max = max(1, min(ngram_max, 3))

	try:
		diversity = float(request_data.get('diversity', 0.7))
	except ValueError:
		diversity = 0.7
	diversity = max(0.0, min(diversity, 1.0))

	try:
		score_threshold = float(request_data.get('score_threshold', 0.30))
	except ValueError:
		score_threshold = 0.30
	score_threshold = max(0.0, min(score_threshold, 1.0))

	use_mmr_raw = str(request_data.get('use_mmr', 'true')).lower()
	use_mmr = use_mmr_raw in ('1', 'true', 'yes', 'y', 'on')

	# Instantiate the KeyBERT model once (lazy init)
	if kw_model is None:
		kw_model = KeyBERT()

	# Extract keywords with different ngram ranges
	ngram_ranges = [(1, 1)]
	if ngram_max >= 2:
		ngram_ranges.append((1, 2))
	if ngram_max >= 3:
		ngram_ranges.append((1, 3))

	combined_keywords = []
	for r in ngram_ranges:
		combined_keywords.extend(
			kw_model.extract_keywords(
				doc,
				keyphrase_ngram_range=r,
				stop_words=None,
				nr_candidates=nr_candidates,
				top_n=top_n,
				use_mmr=use_mmr,
				diversity=diversity,
			)
		)

	# Filter keywords based on a score threshold
	filtered_keywords = [keyword for keyword, score in combined_keywords if score >= score_threshold]

	# De-duplicate while preserving order
	seen = set()
	filtered_keywords_unique = []
	for kw in filtered_keywords:
		if kw in seen:
			continue
		seen.add(kw)
		filtered_keywords_unique.append(kw)

	# Count the number of keywords
	num_keywords = len(filtered_keywords_unique)

	# Create a dictionary for model information
	model_info = {
		"name": "all-MiniLM-L6-v2",
		"model_checksum": checksum,
		"params": {
			"top_n": top_n,
			"nr_candidates": nr_candidates,
			"ngram_max": ngram_max,
			"use_mmr": use_mmr,
			"diversity": diversity,
			"score_threshold": score_threshold
		}
	}

	# Return JSON response with the number of keywords, keywords array, model name, and checksum
	return jsonify(num_keywords=num_keywords, keywords=filtered_keywords_unique, model=model_info)


# test performance of the keyword extraction function
@app.route('/test_keywords', methods=['POST'])
def test_keywords():
	# Get JSON data from the request body
	data = request.get_json()

	# Check if 'doc' and 'times' are provided
	if 'doc' not in data or 'times' not in data:
		return jsonify(error="Document and number of times must be provided"), 400

	doc = data['doc']
	times = int(data['times'])

	# List to store the time taken for each trial
	time_taken = []

	for _ in range(times):
		start_time = time.time()

		# Call the keyword extraction function
		kw_model = KeyBERT()

		kw_model.extract_keywords(doc, keyphrase_ngram_range=(1, 1), stop_words=None, nr_candidates=100, top_n=50,
		                          use_mmr=True, diversity=0.7)
		kw_model.extract_keywords(doc, keyphrase_ngram_range=(1, 2), stop_words=None, nr_candidates=100, top_n=50,
		                          use_mmr=True, diversity=0.7)

		end_time = time.time()
		time_taken.append(end_time - start_time)

	# Calculate the average and standard deviation of the time taken
	avg_time = statistics.mean(time_taken)  # Use statistics.mean
	std_dev_time = statistics.stdev(time_taken)  # Use statistics.stdev

	# Return the average time and standard deviation as a JSON response
	return jsonify(average_time=avg_time, standard_deviation=std_dev_time)


if __name__ == '__main__':
	kw_model = KeyBERT()
	sentence_transformer_model = kw_model.model

	# get access to the underlying BERT model for obtaining checksum (Hugging Face transformer model)
	bert_model = sentence_transformer_model.embedding_model

	# Assuming `bert_model` is the model from the previous code
	state_dict = bert_model.state_dict()

	# Serialize the state dictionary to an in-memory buffer
	buffer = io.BytesIO()
	torch.save(state_dict, buffer)
	state_dict_bytes = buffer.getvalue()

	# Compute the checksum of the model using SHA-256
	checksum = hashlib.sha256(state_dict_bytes).hexdigest()

	# Run the Flask app
	app.run(host="0.0.0.0", port=5003)
