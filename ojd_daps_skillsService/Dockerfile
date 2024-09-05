# Use a Python base image
FROM python:3.10.4-slim

# Install git
RUN apt-get update && apt-get install -y git

# Install specific commit from GitHub
RUN pip install git+https://github.com/nestauk/ojd_daps_skills.git@06edb1497c5b033eebfbb59d2196f77e3900d0be

# Install Flask
RUN pip install flask

# Install SpaCy English model
RUN python -m spacy download en_core_web_sm

# Copy local data into container
COPY ./setupFunction/ojd_daps_skills /usr/local/lib/python3.10/site-packages/ojd_daps_skills
COPY ./setupFunction/ojd_daps_skills_data /usr/local/lib/python3.10/site-packages/ojd_daps_skills_data

# Set the working directory in the container
WORKDIR /app

# Copy the Python script into the container
COPY ojd_daps_skillsService.py /app/ojd_daps_skillsService.py

# Expose the port that the Flask application will listen on
EXPOSE 5005

# Command to run the Flask application
CMD ["python", "ojd_daps_skillsService.py"]
