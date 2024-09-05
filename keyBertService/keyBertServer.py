from flask import Flask, request, jsonify
import hashlib
import torch
import io
from keybert import KeyBERT
import time
import statistics  # Import statistics module

# Declare checksum as a global variable
checksum = None

app = Flask(__name__)

@app.route('/keywords', methods=['GET'])
def get_keywords():
	global checksum  # Ensure we're accessing the global checksum variable

	# Get request doc from args
	request_data = request.args

	# Check if 'doc' key exists in the request data
	if 'doc' not in request_data:
		return jsonify(error="Document not provided"), 400

	# Extract the document text from the request data
	doc = request_data['doc']

	# Instantiate the KeyBERT model
	kw_model = KeyBERT()

	# Extract keywords with different ngram ranges
	keywords_with_scores1 = kw_model.extract_keywords(doc, keyphrase_ngram_range=(1, 1), stop_words=None, nr_candidates=100, top_n=50, use_mmr=True, diversity=0.7)
	keywords_with_scores2 = kw_model.extract_keywords(doc, keyphrase_ngram_range=(1, 2), stop_words=None, nr_candidates=100, top_n=50, use_mmr=True, diversity=0.7)

	# Combine the keyword lists
	combined_keywords = keywords_with_scores1 + keywords_with_scores2

	# Filter keywords based on a score threshold
	filtered_keywords = [keyword for keyword, score in combined_keywords if score >= 0.30]

	# Count the number of keywords
	num_keywords = len(filtered_keywords)

	# Create a dictionary for model information
	model_info = {
		"name": "all-MiniLM-L6-v2",
		"model_checksum": checksum
	}

	# Return JSON response with the number of keywords, keywords array, model name, and checksum
	return jsonify(num_keywords=num_keywords, keywords=filtered_keywords, model=model_info)

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

		kw_model.extract_keywords(doc, keyphrase_ngram_range=(1, 1), stop_words=None, nr_candidates=100, top_n=50, use_mmr=True, diversity=0.7)
		kw_model.extract_keywords(doc, keyphrase_ngram_range=(1, 2), stop_words=None, nr_candidates=100, top_n=50, use_mmr=True, diversity=0.7)

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
