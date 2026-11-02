import mediapipe as mp
import cv2

class EyeDetector():
    def __init__(self, mode=False, num_faces=1, refine_landmarks=True, detectionCon=0.5, trackCon=0.5):
        self.mode = mode
        self.num_faces = num_faces
        self.refine_landmarks = refine_landmarks
        self.detectionCon = detectionCon
        self.trackCon = trackCon

        self.mpFace = mp.solutions.face_mesh
        self.face = self.mpFace.FaceMesh(
            static_image_mode=self.mode,
            max_num_faces=self.num_faces,
            refine_landmarks=self.refine_landmarks,
            min_detection_confidence=self.detectionCon,
            min_tracking_confidence=self.trackCon
        )

        self.mpDraw = mp.solutions.drawing_utils



    def findEyes(self, img, draw_iris=False, draw_lines=False):
        pointSpec = self.mpDraw.DrawingSpec(color=(255,255,0), circle_radius=1)
        lineSpec = self.mpDraw.DrawingSpec(color=(255,255,255), thickness=1)
        left_iris = [468, 469, 470, 471, 472]
        right_iris = [473, 474, 475, 476, 477]
        iris_connections = list(self.mpFace.FACEMESH_RIGHT_IRIS) + list(self.mpFace.FACEMESH_LEFT_IRIS)
        imgRGB = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        self.result = self.face.process(imgRGB)
        if self.result.multi_face_landmarks:
            for faceLms in self.result.multi_face_landmarks:
                # self.mpDraw.draw_landmarks(img, faceLms, self.mpFace.FACEMESH_CONTOURS, pointSpec, lineSpec)


                #show lines
                for a, b in iris_connections:
                    h, w = img.shape[:2]
                    p1 = faceLms.landmark[a]
                    p2 = faceLms.landmark[b]
                    x1, y1 = int(p1.x * w), int(p1.y * h)
                    x2, y2 = int(p2.x * w), int(p2.y * h)
                    if draw_lines:
                        cv2.line(img, (x1, y1), (x2, y2), (255, 255, 255), 1)



                #show eye iris
                for id, lm in enumerate(faceLms.landmark):
                    if id in left_iris or id in right_iris:
                        h, w = img.shape[:2]
                        cx, cy = int(lm.x * w), int(lm.y * h)
                        if draw_iris:
                            cv2.circle(img, (cx, cy), 1, (255,255,0), cv2.FILLED)

        return img







# def main():
#     cap = cv2.VideoCapture(0)
#     detector = EyeDetector()
#
#     while True:
#         success, img = cap.read()
#         img = cv2.flip(img, 1)
#         img = detector.findEyes(img, True, True)
#
#         cv2.imshow('image', img)
#         cv2.waitKey(1)
#
#
#
#
# if __name__ == "__main__":
#     main()