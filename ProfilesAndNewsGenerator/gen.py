import csv
import json
from openai import OpenAI
def convert_llm_response_to_json_v2(llm_response ):
    llm_response_data = llm_response.content[0].text.value.strip()
    start_index = llm_response_data.find('{')
    end_index = llm_response_data.rfind('}')
    json_response = json.loads(llm_response_data[start_index:end_index + 1].strip())
    return json_response

# Initialize OpenAI client
client = OpenAI(api_key='sk-proj-<ADD-YOUR-API-KEY>')

# Create the assistant with specified instructions
assistant  = client.beta.assistants.create(
	name="ESCO SKILL CREATOR",
	temperature=1.02,
	top_p=1.0,
	response_format={"type": "json_object"},
	model="gpt-4o",
	instructions="""
    You are an article/news writer AI. Your task is to use the ESCO ontology to generate profiles of individuals for creating news articles. Each profile must include the person's Name, Surname, gender, and a BIO that maps directly to ESCO ontology skills. 

    Ensure that the technologies and knowledge expressed in the articles are related to the ESCO skills listed in the BIO, even in name. The output should be in JSON format.

    The input will request you to create a profile; your response should be a unique profile with the following specifications:

    1. Create an equal number of male and female profiles (50/50 gender split).
    2. Generate a bio of exactly 1000 characters highlighting a set of skills that align with ESCO ontology.
    3. True news articles must relate to the ESCO skills listed in the bio. Fake news articles should generally be unrelated to the person's ESCO skills. According to the Oxford Internet Institute Report (2018), 90% of fake news is from sources lacking credibility. Therefore, at least 90% of the fake news articles should be completely unrelated to the person's ESCO skills.
    It is mandatory that the technologies and knwoledge expressed in the articles are related to the ESCO in the bio, even in name.
    Make the sure that al true news articles are related to the skills included in the person bio.
    Structure each profile as follows,IT IS MANDATORY TO FOLLOW THIS EXACT STRUCTURE FOR EACH PROFILE:
    {
        "name": "First Name",
        "surname": "Last Name",
        "gender": "male | female",
        "bio": "A detailed summary of the person's skills and expertise related to ESCO ontology.",
        "articles": [
            {
                "title": "Article Title",
                "content": "Exactly 1000 characters of content related to the article.",
                "news-status": "true-news | false-news",
                "url": "URL of the news source"
            }
        ]
    }

    For each profile, generate 5 news articles:
    - 3 true news articles related to the person's ESCO skills.
    - 2 fake news articles that are generally unrelated to the person's ESCO skills.

    The ESCO dataset version must be v1.2.0. Only use the labels from the specified list.

    Each profile must be unique. Use the seed provided as a base for the generation.
    """
)

# Create a new thread
thread = client.beta.threads.create()

# Create a message to initiate the profile generation
message = client.beta.threads.messages.create(
    thread_id=thread.id,
    role="user",
    content="""As per your instruction, proceed to create a profile with ESCO SKILLS in the bio, make sure that the exact number of articles
    specified in your instructions are generated, and that the profile is unique with respect to any other past generated.
    Make sure that no reference to the person's name, surname, or gender is included in the title or content of the articles.
    	It is mandatory that the technologies and knwoledge expressed in the articles are related to the ESCO in the bio, even in name.
    Make the sure that al true news articles are related to the skills included in the person bio, while false news articles are
    generally unrelated to the skills. Use as seed:"""
)

# Run the assistant to generate profiles and articles
run = client.beta.threads.runs.create_and_poll(
    thread_id=thread.id,
    assistant_id=assistant.id,
    instructions=""""""
)

if run.status == 'completed':
	# Initialize an empty list to hold the data
	data_list = []

	for i in range(111,121,1):
		# Create a message to initiate the profile generation
		message = client.beta.threads.messages.create(
			thread_id=thread.id,
			role="user",
			content="""As per your instruction, proceed to create a profile with ESCO SKILLS in the bio. Ensure that the exact number of articles specified in your instructions are generated, and that the profile is unique with respect to any other past generated. Make sure that no reference to the person's name, surname, or gender is included in the title or content of the articles. It is mandatory that the technologies and knowledge expressed in the articles are related to the ESCO in the bio, even in name. Make sure that all true news articles are related to the skills included in the person bio, while false news articles are generally unrelated to the skills. Make sure
			that the format of the profile is exactly corresponding to that defined in your instruction, both in json structure and json keys being lowercase always. Use as seed:""" + str(i)
		)

		# Create a new message to initiate the profile generation
		run = client.beta.threads.runs.create_and_poll(
			thread_id=thread.id,
			assistant_id=assistant.id,
			instructions=""""""
		)
		response = client.beta.threads.messages.list(
			thread_id=thread.id
		)
		print(response)
		data = convert_llm_response_to_json_v2(response.data[0])
		print(data)
		data_list.append(data)

		# Write the JSON data to a file every 10 iterations
		if (i + 1) % 10 == 0:
			json_data = json.dumps(data_list, indent=2)
			with open('output_' + str((i + 1) // 10) + '.json', 'w') as f:
				f.write(json_data)

	# Write the JSON data to a file after the loop ends to ensure all data is saved
	json_data = json.dumps(data_list, indent=2)
	with open('output_final.json', 'w') as f:
		f.write(json_data)

	# Print the collected data
	print(json_data)

else:
	print(run.status)
