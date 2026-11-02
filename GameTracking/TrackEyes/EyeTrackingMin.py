import cv2
import mediapipe as mp
import time

cap = cv2.VideoCapture(0)

mpFace = mp.solutions.face_mesh
face = mpFace.FaceMesh(refine_landmarks=True)

mpDraw = mp.solutions.drawing_utils
pointSpec = mpDraw.DrawingSpec(color=(255,255,0), circle_radius=1)
lineSpec = mpDraw.DrawingSpec(color=(255,255,255), thickness=1)

left_iris = [468, 469, 470, 471, 472]
right_iris = [473, 474, 475, 476, 477]
iris_connections = list(mpFace.FACEMESH_LEFT_IRIS) + list(mpFace.FACEMESH_RIGHT_IRIS)
# print(iris_connections)

while True:
    success, img = cap.read()
    img = cv2.flip(img, 1)
    imgRGB = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    result = face.process(imgRGB)
    if result.multi_face_landmarks:
        # print(result.multi_face_landmarks)
        for faceLms in result.multi_face_landmarks:
            # print(faceLms)
            # mpDraw.draw_landmarks(img, faceLms, mpFace.FACEMESH_IRISES, pointSpec, lineSpec)

            h, w, c = img.shape
            for a, b in iris_connections:
                p1 = faceLms.landmark[a]
                p2 = faceLms.landmark[b]
                x1, y1 = int(p1.x * w), int(p1.y * h)
                x2, y2 = int(p2.x * w), int(p2.y * h)
                cv2.line(img, (x1, y1), (x2, y2), (255, 255, 255), 1)


            for id, lm in enumerate(faceLms.landmark):
                # print(id, lm)
                if id in left_iris or id in right_iris:
                    # h, w, c = img.shape
                    cx, cy = int(lm.x * w), int(lm.y * h)
                    cv2.circle(img, (cx, cy), 2, (255, 255, 0), cv2.FILLED)

    cv2.imshow("image", img)
    cv2.waitKey(1)