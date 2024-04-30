# Use a Python base image
FROM python:3.10.4-slim


RUN apt-get update && apt-get install -y git
RUN pip install git+https://github.com/nestauk/ojd_daps_skills.git@dev
RUN pip install flask
RUN python -m spacy download en_core_web_sm

WORKDIR  /usr/local/lib/python3.10/site-packages
COPY ./setupFunction/ojd_daps_skills_data ./

# Set the working directory in the container
WORKDIR /app

# Copy the Python script into the container
COPY ojd_daps_skillsService.py /app/ojd_daps_skillsService.py

# Expose the port that the Flask application will listen on
EXPOSE 5005

# Command to run the Python script
CMD ["python", "ojd_daps_skillsService.py"]

