from flask import Flask, request, jsonify
from ojd_daps_skills.pipeline.extract_skills.extract_skills import ExtractSkills  # import the module
import json
import io
import os
import torch
import hashlib
import time
import statistics

es = None
model = {}

def initialize_es_model():
	global es
	es = ExtractSkills(config_name="extract_skills_esco_special", local=True)  # instantiate with toy taxonomy configuration file
	es.load()  # load necessary models

	# Access the model attributes
	state_dict = es.skill_mapper.bert_model.bert_model.state_dict()
	bertModelName = es.skill_mapper.bert_model.bert_model_name

	# Compute checksum of the serialized state dictionary
	buffer = io.BytesIO()
	torch.save(state_dict, buffer)
	state_dict_bytes = buffer.getvalue()
	checksumBert = hashlib.sha256(state_dict_bytes).hexdigest()

	# Access ner_model_path
	ner_model_path = es.ner_model_path
	ner_model_name = "spacy_ner_model"

	# Define the path to config.cfg file
	config_file_path = os.path.join(ner_model_path, 'config.cfg')

	# Compute the checksum of the config.cfg file using SHA-256
	with open(config_file_path, 'rb') as config_file:
		config_data = config_file.read()
		config_checksum = hashlib.sha256(config_data).hexdigest()

	# Update global model dictionary with model names and checksums
	global model
	model = {
		'OJD_DAPS_BERTMODELNAME': bertModelName,
		'OJD_DAPS_BERMODELCHECKSUM': checksumBert,
		'OJD_DAPS_NERMODELNAME': ner_model_name,
		'OJD_DAPS_NERMODELCHECKSUM': config_checksum
	}


app = Flask(__name__)

@app.route('/keyword_to_skills', methods=['GET'])
def get_skills_from_keywords():
	global es, model
	# Parse JSON data from the request body
	request_data = request.args

	print("request data")
	print(request_data)
	print("end request data")

	# Check if 'keywords' key exists in the JSON argument
	if 'keywords' not in request_data:
		return jsonify(error="Keywords not provided"), 400

	# Extract the keywords text from the JSON argument
	keywords_list = request_data['keywords']
	keywords_dict = json.loads(keywords_list)

	# Extract values and create an array
	array_from_string = list(keywords_dict.values())

	print(array_from_string)

	skills_list_matched = es.map_skills(array_from_string)  # match formatted skills to taxonomy
	print("matched skills")
	print(skills_list_matched)

	# Count the number of skills
	num_skills = len(skills_list_matched)

	# Return JSON response with number of skills, skills array, and model info
	return jsonify(num_skills=num_skills, skills=skills_list_matched, model=model)



@app.route('/test_keyword_to_skills', methods=['GET'])
def get_skills_from_keywords_performance():
	global es, model
	# Parse JSON data from the request args
	request_data = request.args

	# Initialize performance tracking
	num_trials = int(request_data.get('trials', 1))  # Number of trials, default to 1 if not specified
	response_times = []

	# Check if 'keywords' key exists in the JSON argument
	if 'keywords' not in request_data:
		return jsonify(error="Keywords not provided"), 400

	# Extract the keywords text from the JSON argument
	keywords_list = request_data['keywords']
	keywords_dict = json.loads(keywords_list)

	# Extract values and create an array
	array_from_string = list(keywords_dict.values())

	for _ in range(num_trials):
		start_time = time.time()

		# Match formatted skills to taxonomy
		skills_list_matched = es.map_skills(array_from_string)

		end_time = time.time()

		# Measure response time
		elapsed_time = end_time - start_time
		response_times.append(elapsed_time)

	# Calculate average response time and standard deviation
	avg_response_time = sum(response_times) / num_trials
	std_dev_response_time = statistics.stdev(response_times) if num_trials > 1 else 0

	# Count the number of skills
	num_skills = len(skills_list_matched)

	# Return JSON response with number of skills, skills array, and model info
	return jsonify(
		num_skills=num_skills,
		skills=skills_list_matched,
		model=model,
		average_response_time=avg_response_time,
		std_dev_response_time=std_dev_response_time
	)

@app.route('/text_to_skills', methods=['GET'])
def get_skills_from_document():
	global es, model
	# Parse JSON data from the request body
	print("full request" + str(request))
	request_data = request.json

	# Check if 'doc' key exists in the JSON argument
	if 'doc' not in request_data:
		return jsonify(error="Document not provided"), 400

	# Extract the document text from the JSON argument
	doc = request_data['doc']

	skills_list_matched = es.map_skills(doc)  # match formatted skills to toy taxonomy

	# Count the number of skills
	num_skills = len(skills_list_matched)

	# Return JSON response with number of skills, skills array, and model info
	return jsonify(num_skills=num_skills, skills=skills_list_matched, model=model)


if __name__ == '__main__':
	initialize_es_model()
	print("Model Information:", model)

	# Start Flask app
	initialize_es_model()
	app.run(host="0.0.0.0", port=int("5005"))
