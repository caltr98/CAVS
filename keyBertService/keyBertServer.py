from flask import Flask, request, jsonify
from keybert import KeyBERT

app = Flask(__name__)

@app.route('/keywords', methods=['GET'])
def get_keywords():
    # Parse JSON data from the request body
    # Print the request details for debugging

    #get request doc from args
    request_data = request.args

    # Check if 'doc' key exists in the JSON data
    if 'doc' not in request_data:
        return jsonify(error="Document not provided"), 400

    # Extract the document text from the JSON data
    doc = request_data['doc']

    kw_model = KeyBERT()
    keywords_with_scores1 = kw_model.extract_keywords(doc, keyphrase_ngram_range=(1, 1), stop_words=None, threshold=0.3)
    keywords_with_scores2 = kw_model.extract_keywords(doc, keyphrase_ngram_range=(1, 2), stop_words=None,threshold=0.3)

    # Combine the keyword lists
    combined_keywords = [keyword for keyword, _ in keywords_with_scores1]
    combined_keywords.extend([keyword for keyword, _ in keywords_with_scores2])

    print(combined_keywords)
    # Count the number of keywords
    num_keywords = len(combined_keywords)

    # Return JSON response with number of keywords and keywords array
    return jsonify(num_keywords=num_keywords, keywords=combined_keywords)

if __name__ == '__main__':
    app.run(host="0.0.0.0", port=int("5003"))
