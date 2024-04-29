from flask import Flask, request, jsonify
from keybert import KeyBERT
import os
import openai
from keybert.llm import OpenAI
from keybert import KeyLLM

app = Flask(__name__)

# Initialize global variables
llm = None

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
    print(keywordsofdocs)
    #get keywords for input and remove empty string if returned
    keywords = [keyword for keyword in keywordsofdocs[0] if keyword.strip()]
    # Count the number of keywords
    num_keywords = len(keywords)
    # Return JSON response with number of keywords and keywords array
    return jsonify(num_keywords=num_keywords, keywords=keywords)

@app.route('/keywords_both', methods=['GET'])
def get_keywords_both():
    global llm

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
    keywordsofdocs = kw_model.extract_keywords(doc,keyphrase_ngram_range=(1, 2),top_n=10)

    #get keywords for input and remove empty string if returned
    keywords = [keyword for keyword in keywordsofdocs[0] if keyword.strip()]
    # Count the number of keywords
    num_keywords = len(keywords)

    # Return JSON response with number of keywords and keywords array
    return jsonify(num_keywords=num_keywords, keywords=keywords)


if __name__ == '__main__':
    initialize_openai_client()
    app.run(host="0.0.0.0", port=int("5002"))

