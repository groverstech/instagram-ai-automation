from PIL import Image, ImageDraw, ImageFont
import yaml
with open("config/settings.yaml") as f: settings = yaml.safe_load(f)
FONT_PATH = settings["font_path"]
IMAGE_SIZE = tuple(settings["image_size"])
BACKGROUND_COLOR = tuple(settings["background_color"])
TEXT_COLOR = tuple(settings["text_color"])
FONT_SIZE = settings["font_size"]
def create_image(text, output_path="data/output.png"):
    base = Image.new('RGB', IMAGE_SIZE, BACKGROUND_COLOR)
    draw = ImageDraw.Draw(base)
    font = ImageFont.truetype(FONT_PATH, FONT_SIZE)
    w, h = draw.textsize(text, font)
    draw.text(((IMAGE_SIZE[0]-w)/2,(IMAGE_SIZE[1]-h)/2), text, TEXT_COLOR, font=font)
    base.save(output_path)
    return output_path
