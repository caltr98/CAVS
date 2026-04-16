#Scrap 

import requests #Requests allows to send HTTP/1.1 requests

#Utilitaires 
import json
import pandas as pd
import numpy as np
from pandas import json_normalize

from concurrent.futures import ThreadPoolExecutor

#Neo4j

from neo4j import GraphDatabase
from py2neo import Graph
from neomodel import StructuredNode, StringProperty, RelationshipTo, RelationshipFrom, config



if __name__ == '__main__':
	occ_url = "https://ec.europa.eu/esco/api/search?language=en&isInScheme=http://data.europa.eu/esco/concept-scheme/occupations&limit=3561"
	response = requests.get(occ_url) #Store the request into a new variable
	Occupation_source = response.json()
	Occupation = Occupation_source['_embedded']
	df_Occupation = pd.DataFrame(Occupation["results"]) #Convert to pandas