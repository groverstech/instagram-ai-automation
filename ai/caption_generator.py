import openai
import os
from dotenv import load_dotenv

load_dotenv()
client = openai.OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

def generate_caption():
    prompt = (
        "Write a short, engaging Instagram caption based on current market trends in finance or tech. "
        "Use 2 relevant hashtags and emojis. Max 2200 characters."
    )

    response = client.chat.completions.create(
        model="gpt-4",
        messages=[{"role": "user", "content": prompt}]
    )

    caption = response.choices[0].message.content
    return caption.strip()
