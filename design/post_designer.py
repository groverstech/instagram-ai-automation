from PIL import Image, ImageDraw, ImageFont

def create_image(caption, output_path="images/generated_post.jpg"):
    width, height = 1080, 1080
    image = Image.new("RGB", (width, height), color="white")
    draw = ImageDraw.Draw(image)

    font = ImageFont.load_default()
    draw.text((50, 500), caption, font=font, fill="black")

    image.save(output_path)
    return output_path
