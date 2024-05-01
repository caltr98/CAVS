# Use a Python base image
FROM python:3.10-slim

# Set the working directory in the container
WORKDIR /app

# Install Git
RUN apt-get update && apt-get install -y git

# Install dependency keybert from pip
RUN pip install git+https://github.com/MaartenGr/KeyBERT.git flask

# Copy the Python script into the container
COPY keyBertServer.py /app/keyBertServer.py

EXPOSE 5003

# Command to run the Python script
CMD ["python", "keyBertServer.py"]
