import json
import requests

# Function to read data from a JSON file
def read_data(file_path):
	with open(file_path, 'r') as file:
		return json.load(file)

# Function to write updated data to a JSON file
def write_data(file_path, data):
	with open(file_path, 'w') as file:
		json.dump(data, file, indent=4)

# Function to extract skills from bio by calling the API
def extract_skills_from_text(text):
	url = 'http://localhost:4200/simulation/skillsfromtext'  # Ensure this matches your server's endpoint
	try:
		response = requests.post(url, json={'text': text})
		response.raise_for_status()  # Raise an error for bad status codes
		return response.json().get('skills', [])
	except requests.exceptions.RequestException as e:
		print(f"Request error: {e}")
		return []

# Function to count skill matches
def count_skill_matches(skills1, skills2):
	matches = 0
	for skill1 in skills1:
		for skill2 in skills2:
			if skill1 == skill2:
				matches += 1
	return matches

# Function to add IDs to authors and articles and extract skills
def add_ids_and_extract_skills(data, output_file):
	for author_index, author in enumerate(data, start=1):
		print("processing author" + str(author_index))
		bio = author['bio']
		skills_for_author = extract_skills_from_text(bio)
		author['skills'] = skills_for_author
		author['author_id'] = author_index

		for article_index, article in enumerate(author['articles'], start=1):
			article['article_id'] = article_index
			article_content = article['title'] + ' ' + article['content']
			skills_for_article = extract_skills_from_text(article_content)
			article['skills'] = skills_for_article
			# Count skill matches between the author and the article
			skill_matches = count_skill_matches(skills_for_author, skills_for_article)
			article['matches_skills'] = skill_matches

		if author_index % 10 == 0:
			print(f"Saving progress at author {author_index}")
			write_data(output_file, data[:author_index])

		print("completed author" + str(author_index))
	return data

# Main execution
input_file = 'output_1.json'
output_file = 'skill_1.json'

# Read the original data from file
data = read_data(input_file)

# Add author_id, article_id, and extract skills
updated_data = add_ids_and_extract_skills(data, output_file)

# Write the final updated data to a new file
write_data(output_file, updated_data)

print(f"Updated data with IDs and skills has been written to {output_file}")
