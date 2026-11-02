import cv2
import FaceMeshModule as fmm

cap = cv2.VideoCapture(0)
detector = fmm.FaceDetector()

while True:
    success, img = cap.read()
    img = cv2.flip(img, 1)
    img = detector.findFace(img, draw=False)

    landmarks = detector.findPositon(img, True, True)
    print(landmarks)

    cv2.imshow('image', img)
    cv2.waitKey(1)