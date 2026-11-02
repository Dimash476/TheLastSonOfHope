import cv2
import mediapipe as mp

cap = cv2.VideoCapture(0)

mpFace = mp.solutions.face_mesh
face = mpFace.FaceMesh()
mpDraw = mp.solutions.drawing_utils

pointSpec = mpDraw.DrawingSpec(color=(255, 255, 0), circle_radius=1)
lineSpec = mpDraw.DrawingSpec(color=(255, 255, 255), thickness=1)

while True:
    success, img = cap.read()
    img = cv2.flip(img, 1)
    imgRGB = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    result = face.process(img)
    if result.multi_face_landmarks:
        # print(result.multi_face_landmarks)
        for faceLms in result.multi_face_landmarks:
            mpDraw.draw_landmarks(img, faceLms, mpFace.FACEMESH_CONTOURS, pointSpec, lineSpec)
            # print(faceLms)
            for id, lm in enumerate(faceLms.landmark):
                h, w = img.shape[:2]
                cx, cy = int(lm.x * w), int(lm.y * h)
                # print(id, cx, cy)

    cv2.imshow('image', img)
    cv2.waitKey(1)