from flask import Flask, request, jsonify
from ojd_daps_skills.pipeline.extract_skills.extract_skills import ExtractSkills #import the module
import json

es = None

def initialize_es_model():
    global es
    es = ExtractSkills(config_name="extract_skills_esco", local=True) #instantiate with toy taxonomy configuration file
    es.load() #load necessary models


app = Flask(__name__)


@app.route('/keyword_to_skills', methods=['GET'])
def get_skills_from_keywords():
    global es
    # Parse JSON data from the request body

    request_data = request.args


    # Check if 'keywords' key exists in the JSON argument
    if 'keywords' not in request_data:
        return jsonify(error="Keywords not provided"), 400

    # Extract the keywords text from the JSON argument
    keywords_list = request_data['keywords']
    keywords_dict = json.loads(keywords_list)

    # Extract values and create an array
    array_from_string = list(keywords_dict.values())


    print(array_from_string)

    skills_list_matched = es.map_skills(array_from_string)  # match formatted skills to toy taxonomy
    print("matched skills   ")
    print(skills_list_matched)
    # Count the number of keywords
    num_skills = len(skills_list_matched)

    # Return JSON response with number of skills and skills array
    return jsonify(num_skills=num_skills, skills=skills_list_matched)

@app.route('/text_to_skills', methods=['GET'])
def get_skills_from_document():
    global es
    # Parse JSON data from the request body
    print("full request"+request)
    request_data = request.json

    # Check if 'keywords' key exists in the JSON argument
    if 'doc' not in request_data:
        return jsonify(error="Keywords not provided"), 400

    # Extract the keywords text from the JSON argument
    doc = request_data['doc']

    skills_list_matched = es.map_skills(doc)  # match formatted skills to toy taxonomy

    # Count the number of keywords
    num_skills = len(skills_list_matched)

    # Return JSON response with number of skills and skills array
    return jsonify(num_skills=num_skills, skills=skills_list_matched)



if __name__ == '__main__':
    initialize_es_model()
    app.run(host="0.0.0.0", port=int("5005"))
