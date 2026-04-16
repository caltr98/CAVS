from flask import Flask, request, jsonify
from keybert import KeyBERT
import openai
from keybert.llm import OpenAI
from keybert import KeyLLM
import json
import hashlib
import torch
import io
import time
import statistics
import os

app = Flask(__name__)

# Initialize global variables
llm = None
bert_model_checksum = None
runtime_api_key_override = None
runtime_base_url_override = None

def _parse_float(value, default):
	try:
		return float(value)
	except (TypeError, ValueError):
		return default


def _parse_int(value, default):
	try:
		return int(value)
	except (TypeError, ValueError):
		return default


def _mask_api_key(value):
	if not value:
		return ""
	value = value.strip()
	if len(value) <= 8:
		return "*" * len(value)
	return f"{value[:4]}...{value[-4:]}"


def _resolve_api_key():
	api_key = runtime_api_key_override
	if api_key:
		return api_key

	api_key = os.getenv("OPENAI_API_KEY")
	if api_key:
		return api_key

	for candidate in ("./app/openai_api_key.txt", "./openai_api_key.txt"):
		if os.path.exists(candidate):
			with open(candidate, 'r') as file:
				api_key = file.read().strip()
			if api_key:
				return api_key
	return None


def _resolve_base_url():
	return (
		runtime_base_url_override
		or os.getenv("OPENAI_BASE_URL")
		or os.getenv("AZURE_OPENAI_ENDPOINT")
		or "https://cavs.openai.azure.com/openai/v1"
	)


def current_openai_config():
	api_key = _resolve_api_key()
	base_url = _resolve_base_url()
	return {
		"configured": llm is not None,
		"has_api_key": bool(api_key),
		"api_key_masked": _mask_api_key(api_key),
		"base_url": base_url,
		"source": "runtime" if runtime_api_key_override or runtime_base_url_override else "environment"
	}


def initialize_openai_client():
	global llm
	try:
		api_key = _resolve_api_key()

		if not api_key:
			raise RuntimeError("Missing OpenAI API key (set OPENAI_API_KEY or provide ./openai_api_key.txt)")

		base_url = _resolve_base_url()

		# Create the OpenAI client
		client = openai.OpenAI(base_url=base_url, api_key=api_key)
		llm = OpenAI(client)
		print("OpenAI client initialized")
	except Exception as e:
		print("Error initializing OpenAI client:", str(e))
		llm = None


@app.route('/config/openai', methods=['GET'])
def get_openai_config():
	return jsonify(current_openai_config())


@app.route('/config/openai', methods=['POST'])
def set_openai_config():
	global runtime_api_key_override, runtime_base_url_override

	data = request.get_json(silent=True) or {}

	if 'api_key' in data:
		api_key = (data.get('api_key') or '').strip()
		runtime_api_key_override = api_key or None

	if 'base_url' in data:
		base_url = (data.get('base_url') or '').strip()
		runtime_base_url_override = base_url or None

	initialize_openai_client()
	return jsonify(current_openai_config())


def compute_bert_model_checksum():
	global bert_model_checksum

	# Initialize the KeyBERT model to access the underlying BERT model
	kw_model = KeyBERT()
	sentence_transformer_model = kw_model.model

	# Access the underlying BERT model
	bert_model = sentence_transformer_model.embedding_model

	# Compute the checksum of the BERT model
	state_dict = bert_model.state_dict()
	buffer = io.BytesIO()
	torch.save(state_dict, buffer)
	state_dict_bytes = buffer.getvalue()
	bert_model_checksum = hashlib.sha256(state_dict_bytes).hexdigest()


@app.route('/keywords_only_LMM', methods=['GET'])
def get_keywords_only_LMM():
	global llm

	# Check if llm is initialized
	if llm is None:
		return jsonify(error="OpenAI client is not initialized"), 500

	# Parse JSON data from the request ARGS
	request_data = request.args

	# Check if 'doc' key exists in the JSON data
	if 'doc' not in request_data:
		return jsonify(error="Document not provided"), 400

	# Extract the document text from the JSON data
	doc = request_data['doc']

	kw_model = KeyLLM(llm=llm)

	# Extract keywords, check_vocab remove duplicates
	keywordsofdocs = kw_model.extract_keywords(doc)

	# Get keywords for input and remove empty strings if returned
	keywords = [keyword for keyword in keywordsofdocs[0] if keyword.strip()]
	top_n = _parse_int(request_data.get("top_n"), None)
	if top_n is not None:
		keywords = keywords[:max(0, top_n)]

	# Count the number of keywords
	num_keywords = len(keywords)

	# Return JSON response with number of keywords and keywords array
	return jsonify(
		num_keywords=num_keywords,
		keywords=keywords,
		model={
			"name": "keyBertUseOnlyLLM",
			"model": request_data.get("model", os.getenv("OPENAI_KEYWORD_MODEL", "gpt-4.1")),
			"temperature": _parse_float(request_data.get("temperature"), 0.30),
			"seed": _parse_int(request_data.get("seed"), 123),
			"top_n": top_n
		}
	)


@app.route('/keywords_both', methods=['GET'])
def get_keywords_both():
	global llm, bert_model_checksum

	# Check if llm is initialized
	if llm is None:
		return jsonify(error="OpenAI client is not initialized"), 500

	# Parse JSON data from the request args
	request_data = request.args

	# Check if 'doc' key exists in the JSON data
	if 'doc' not in request_data:
		return jsonify(error="Document not provided"), 400

	# Extract the document text from the JSON data
	doc = request_data['doc']

	kw_model = KeyBERT(llm=llm)

	top_n = _parse_int(request_data.get("top_n"), 30)
	# Extract keywords
	keywordsofdocs = kw_model.extract_keywords(doc, keyphrase_ngram_range=(1, 2), top_n=top_n)

	# Get keywords for input and remove empty strings if returned
	keywords = [keyword for keyword in keywordsofdocs[0] if keyword.strip()]

	# Count the number of keywords
	num_keywords = len(keywords)

	# Return JSON response with number of keywords, keywords array, and model details
	return jsonify(
		num_keywords=num_keywords,
		keywords=keywords,
		model={
			"name": "keyBertwithLLM",
			"bertModel": "all-MiniLM-L6-v2",
			"bertModelChecksum": bert_model_checksum,
			"LLMmodel": request_data.get("model", os.getenv("OPENAI_KEYWORD_MODEL", "gpt-4.1")),
			"temperature": _parse_float(request_data.get("temperature"), 0.30),
			"seed": _parse_int(request_data.get("seed"), 123),
			"top_n": top_n
		}
	)


@app.route('/upper_level_keywords', methods=['GET'])
def get_upper_level_keywords():
	global llm

	# Check if llm is initialized
	if llm is None:
		return jsonify(error="OpenAI client is not initialized"), 500

	# Extract the 'keywords' parameter from the request args
	keywords = request.args.get('keywords')

	# Check if 'keywords' key exists in the query parameters
	if not keywords:
		return jsonify(error="'keywords' parameter is missing"), 400

	# Prompt for the AI model
	prompt = (
		"You are an AI designed to extract upper-level keywords from specific terms. These terms can be technical terms, concepts, or product names. You will receive "
		"information in a JSON format containing a \"term\" field:\n\n**Procedure:**\n1. **Term Analysis:** First, determine the broader categories or higher-level "
		"keywords associated with the provided term. This involves understanding the context and domain in which the term is used.\n2. **Keyword Extraction:** Extract "
		"one or more upper-level keywords that best generalize the provided term.\n3. **Example Terms and Their Upper-Level Keywords:**\n   - \"Bitcoin\" -> "
		"[\"Blockchain\", \"Cryptocurrency\"]\n   - \"Ethereum\" -> [\"Blockchain\", \"Cryptocurrency\"]\n   - \"Java\" -> [\"Software Development\", \"Programming "
		"Language\"]\n   - \"Python\" -> [\"Software Development\", \"Programming Language\"]\n   - \"TensorFlow\" -> [\"Machine Learning\", \"Artificial Intelligence\"]"
		"\n   - \"Windows 10\" -> [\"Operating System\", \"Software\"]\n   - \"Galaxy S21\" -> [\"Smartphone\", \"Consumer Electronics\"]\n   - \"NVIDIA GTX 3080\" -> "
		"[\"Graphics Card\", \"Hardware\"]\n   - \"The Great Gatsby\" -> [\"Literature\", \"Novel\"]\n   - \"Monet's Water Lilies\" -> [\"Art\", \"Painting\"]\n   - "
		"\"Pythagorean Theorem\" -> [\"Mathematics\", \"Geometry\"]\n\n**Output Requirements:**\nThe output should be a {Keywords:JSON array of upper-level keywords}."
		"\n\n**Example Input:**\n{\n  \"term\": \"Bitcoin\"\n}\n\n**Example Output:**\n[\"Blockchain\", \"Cryptocurrency\"]\n\n**Example Input:**\n{\n  \"term\": \"Java\"\n"
		"}\n\n**Example Output:**\n[\"Software Development\", \"Programming Language\"]\n\n**Example Input:**\n{\n  \"term\": \"TensorFlow\"\n}\n\n**Example Output:**\n"
		"[\"Machine Learning\", \"Artificial Intelligence\"]\n\n**Example Input:**\n{\n  \"term\": \"The Great Gatsby\"\n}\n\n**Example Output:**\n[\"Literature\", "
		"\"Novel\"]\n\nBased on the above procedure and examples, extract the upper-level keywords for the provided term. Ensure the output is in JSON format {Keywords:jsonarray}")

	try:
		model = request.args.get("model", os.getenv("OPENAI_KEYWORD_MODEL", "gpt-4.1"))
		temperature = _parse_float(request.args.get("temperature"), 0.30)
		seed = _parse_int(request.args.get("seed"), 123)

		# Try the completion with initial temperature
		completion = llm.client.chat.completions.create(
			messages=[
				{
					"role": "user",
					"content": prompt + ' :' + keywords,
				}
			],
			model=model,
			temperature=temperature,
			response_format={"type": "json_object"},
			seed=seed
		)

		# Load the JSON response
		result = json.loads(completion.choices[0].message.content)

		# Check if 'Keywords' key exists in the JSON response
		if 'Keywords' not in result:
			return jsonify(error="Response does not contain 'Keywords'"), 500

		return jsonify({
			**result,
			"model": {
				"type": model,
				"temperature": temperature,
				"seed": seed,
				"prompt": prompt
			}
		})

	except Exception as e:
		return jsonify(error=str(e)), 500


@app.route('/same_level_keywords', methods=['GET'])
def get_synonymous_keywords():
	global llm

	# Check if llm is initialized
	if llm is None:
		return jsonify(error="OpenAI client is not initialized"), 500

	# Extract the 'keywords' parameter from the request args
	keywords = request.args.get('keywords')

	# Check if 'keywords' key exists in the query parameters
	if not keywords:
		return jsonify(error="'keywords' parameter is missing"), 400

	prompt = (
		"You are an AI explorer tasked with uncovering synonymous companions for ONE specific term, that you will receive as text after this prompt with :->. "
		"Embark on a linguistic odyssey to extract perfect synonyms that capture the essence of each term, navigating through the intricacies of language. "
		"Ensure the output is in JSON format {'Keywords':jsonarray} with many relevant keywords, including symbols if applicable. "
		"Avoid upper-level concepts. "
		"\n\nExamples for your guidance:\n"
		"'Bitcoin' ->Output: {'Keywords':['B', 'BTC', '₿']}\n"
		"'Java' ->Output: {'Keywords':['JDK']}\n"
		"'TensorFlow' ->Output: {'Keywords':['TF']}\n"
		"'The Great Gatsby' ->Output: {'Keywords':['Gatsby']}\n"
		"\nYour quest awaits! The output is in format: {'Keywords' :jsonarray of keywords}  where 'Keywords' is the key of the response structure :->"
	)

	try:
		model = request.args.get("model", os.getenv("OPENAI_KEYWORD_MODEL", "gpt-4.1"))
		temperature = _parse_float(request.args.get("temperature"), 0.30)
		seed = _parse_int(request.args.get("seed"), 123)

		# Try the completion with initial temperature
		completion = llm.client.chat.completions.create(
			messages=[
				{
					"role": "user",
					"content": prompt + ' :' + keywords,
				}
			],
			model=model,
			temperature=temperature,
			response_format={"type": "json_object"},
			seed=seed
		)

		# Load the JSON response
		result = json.loads(completion.choices[0].message.content)

		# Check if 'Keywords' key exists in the JSON response
		if 'Keywords' not in result:
			return jsonify(error="Response does not contain 'Keywords'"), 500

		return jsonify({
			**result,
			"model": {
				"type": model,
				"temperature": temperature,
				"seed": seed,
				"prompt": prompt
			}
		})

	except Exception as e:
		return jsonify(error=str(e)), 500


@app.route('/test_keywords_only_LMM', methods=['POST'])
def test_keywords_only_LMM():
	global llm

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

		# Call the keyword extraction function for /keywords_only_LMM
		kw_model = KeyLLM(llm=llm)
		keywordsofdocs = kw_model.extract_keywords(doc)
		keywords = [keyword for keyword in keywordsofdocs[0] if keyword.strip()]

		end_time = time.time()
		time_taken.append(end_time - start_time)

	# Calculate the average and standard deviation of the time taken
	avg_time = statistics.mean(time_taken)
	std_dev_time = statistics.stdev(time_taken)

	# Return the average time and standard deviation as a JSON response
	return jsonify(
		average_time=avg_time,
		standard_deviation=std_dev_time
	)


@app.route('/test_keywords_both', methods=['POST'])
def test_keywords_both():
	global llm, bert_model_checksum

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

		# Call the keyword extraction function for /keywords_both
		kw_model = KeyBERT(llm=llm)
		keywordsofdocs = kw_model.extract_keywords(doc, keyphrase_ngram_range=(1, 2), top_n=30)
		keywords = [keyword for keyword in keywordsofdocs[0] if keyword.strip()]

		end_time = time.time()
		time_taken.append(end_time - start_time)

	# Calculate the average and standard deviation of the time taken
	avg_time = statistics.mean(time_taken)
	std_dev_time = statistics.stdev(time_taken)

	# Return the average time and standard deviation as a JSON response
	return jsonify(
		average_time=avg_time,
		standard_deviation=std_dev_time
	)


if __name__ == '__main__':
	initialize_openai_client()
	compute_bert_model_checksum()
	app.run(host="0.0.0.0", port=int("5002"))
