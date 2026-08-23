from rembg import remove

with open("raw/run.png", "rb") as i:
    with open("work/run.png", "wb") as o:
        input_data = i.read()
        output_data = remove(input_data)
        o.write(output_data)

print("배경 제거 완료!")