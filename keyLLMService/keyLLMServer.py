from flask import Flask, request, jsonify
from keybert import KeyBERT
import os
import openai
from keybert.llm import OpenAI
from keybert import KeyLLM
import json
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
    keywordsofdocs = kw_model.extract_keywords(doc,keyphrase_ngram_range=(1, 2),top_n=30)

    #get keywords for input and remove empty string if returned
    keywords = [keyword for keyword in keywordsofdocs[0] if keyword.strip()]
    # Count the number of keywords
    num_keywords = len(keywords)

    # Return JSON response with number of keywords and keywords array
    return jsonify(num_keywords=num_keywords, keywords=keywords)


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
            response_format={ "type": "json_object" },
            seed = 123
        )

        # Load the JSON response
        result = json.loads(completion.choices[0].message.content)

        # Check if 'Keywords' key exists in the JSON response
        if 'Keywords' not in result:
            return jsonify(error="Response does not contain 'Keywords'"), 500

        return jsonify(result)

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
            response_format={ "type": "json_object" },
            seed = 123
        )

        # Load the JSON response
        result = json.loads(completion.choices[0].message.content)
        return jsonify(result)

        # Check if 'Keywords' key exists in the JSON response
        if 'Keywords' not in result:
            return jsonify(error="Response does not contain 'Keywords'"), 500

        return jsonify(result)

    except Exception as e:
        return jsonify(error=str(e)), 500



if __name__ == '__main__':
    initialize_openai_client()
    app.run(host="0.0.0.0", port=int("5002"))

