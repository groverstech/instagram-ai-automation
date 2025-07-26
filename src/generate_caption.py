import openai, os
from dotenv import load_dotenv
load_dotenv()
openai.api_key = os.getenv("OPENAI_API_KEY")
def generate_caption(topic="Motivational Quote"):
    prompt = f"Create a short Instagram caption about: {topic}. Include 3 trending hashtags."
    response = openai.ChatCompletion.create(model="gpt-4", messages=[{"role": "user", "content": prompt}])
    return response.choices[0].message.content.strip()
