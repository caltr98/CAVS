# Use a Python base image
FROM python:3.10-slim

# Set the working directory in the container
WORKDIR /app


# Install Git
RUN apt-get update && apt-get install -y git

# Install dependencies from pip
RUN pip install git+https://github.com/MaartenGr/KeyBERT.git flask openai

# Copy the API key file into the container
COPY /app/openai_api_key.txt ./app/openai_api_key.txt

# Copy the Python script into the container
COPY keyLLMServer.py /app/keyLMMServer.py

# Expose the port that the Flask application will listen on
EXPOSE 5002

# Command to run the Python script
CMD ["python", "keyLMMServer.py"]
