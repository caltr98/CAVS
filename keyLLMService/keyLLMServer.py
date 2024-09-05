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

app = Flask(__name__)

# Initialize global variables
llm = None
bert_model_checksum = None

def initialize_openai_client():
	global llm
	try:
		# Read the OpenAI API key from the file
		with open('./app/openai_api_key.txt', 'r') as file:
			api_key = file.read().strip()

		# Create the OpenAI client
		client = openai.OpenAI(api_key=api_key)
		llm = OpenAI(client)
		print("OpenAI client initialized")
	except Exception as e:
		print("Error initializing OpenAI client:", str(e))
		llm = None

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

	# Count the number of keywords
	num_keywords = len(keywords)

	# Return JSON response with number of keywords and keywords array
	return jsonify(
		num_keywords=num_keywords,
		keywords=keywords,
		model={
			"name": "keyBertUseOnlyLLM",
			"model": "gpt-3.5-turbo-0125",
			"temperature": 0.30,
			"seed": 123
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

	# Extract keywords, arbitrary 10
	keywordsofdocs = kw_model.extract_keywords(doc, keyphrase_ngram_range=(1, 2), top_n=30)

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
			"LLMmodel": "gpt-3.5-turbo-0125",
			"temperature": 0.30,
			"seed": 123
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
	prompt = ("You are an AI designed to extract upper-level keywords from specific terms. These terms can be technical terms, concepts, or product names. You will receive "
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
		# Try the completion with initial temperature
		completion = llm.client.chat.completions.create(
			messages=[
				{
					"role": "user",
					"content": prompt + ' :' + keywords,
				}
			],
			model="gpt-3.5-turbo-0125",
			temperature=0.30,
			response_format="json",
			seed=123
		)

		# Load the JSON response
		result = json.loads(completion.choices[0].message.content)

		# Check if 'Keywords' key exists in the JSON response
		if 'Keywords' not in result:
			return jsonify(error="Response does not contain 'Keywords'"), 500

		return jsonify(
			result,
			model={
				"type": "gpt-3.5-turbo-0125",
				"temperature": 0.30,
				"seed": 123,
				"prompt": prompt
			}
		)

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

		prompt = ("You are an AI explorer tasked with uncovering synonymous companions for ONE specific term, that you will receive as text after this prompt with :->. "
          "Embark on a linguistic odyssey to extract perfect synonyms that capture the essence of each term, navigating through the intricacies of language. "
          "Ensure the output is in JSON format {'Keywords'(independent from prompt, it will be used for parsing,fix!):jsonarray} with many relevant keywords, including symbols if applicable. "
          "Avoid upper-level concepts. "
          "\n\nExamples for your guidance:\n"
          "'Bitcoin' ->Output: {'Keywords':['B', 'BTC', '₿']}\n"
          "'Java' ->Output: {'Keywords':['JDK']}\n"
          "'TensorFlow' ->Output: {'Keywords':['TF']}\n"
          "'The Great Gatsby' ->Output: {'Keywords':['Gatsby']}\n"
          "\nYour quest awaits! The output is in format: {'Keywords' :jsonarray of keywords}  where 'Keywords' is the key of the response structure :->")

	try:
		# Try the completion with initial temperature
		completion = llm.client.chat.completions.create(
			messages=[
				{
					"role": "user",
					"content": prompt + ' :' + keywords,
				}
			],
			model="gpt-3.5-turbo-0125",
			temperature=0.30,
			response_format="json",
			seed=123
		)

		# Load the JSON response
		result = json.loads(completion.choices[0].message.content)

		# Check if 'Keywords' key exists in the JSON response
		if 'Keywords' not in result:
			return jsonify(error="Response does not contain 'Keywords'"), 500

		return jsonify(
			result,
			model={
				"type": "gpt-3.5-turbo-0125",
				"temperature": 0.30,
				"seed": 123,
				"prompt": prompt
			}
		)

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
