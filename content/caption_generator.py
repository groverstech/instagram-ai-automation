import random

def generate_caption(topic: str) -> str:
    templates = [
        f"📈 Big moves in the market today! {topic.title()} is leading the way.",
        f"🚀 Trending Now: {topic.title()}. Stay informed, stay ahead.",
        f"💡 Quick Insight: {topic.title()} – what's next?",
        f"🔍 Market Focus: {topic.title()}. Analysis coming soon.",
        f"📊 Snapshot: {topic.title()}. What does it mean for investors?"
    ]
    return random.choice(templates)