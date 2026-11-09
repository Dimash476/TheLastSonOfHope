import cv2
import mediapipe as mp

class FaceDetector():
    def __init__(self, mode=False, faces=1, refine_landmarks=True, detectionCon=0.5, trackCon=0.5):
        self.mode = mode
        self.faces = faces
        self.refine_landmarks = refine_landmarks
        self.detectionCon = detectionCon
        self.trackCon = trackCon

        self.mpFace = mp.solutions.face_mesh
        self.face = self.mpFace.FaceMesh(
            static_image_mode=self.mode,
            max_num_faces=self.faces,
            refine_landmarks=self.refine_landmarks,
            min_detection_confidence=self.detectionCon,
            min_tracking_confidence=self.trackCon
        )

        self.mpDraw = mp.solutions.drawing_utils

    def findFace(self, img, draw=False):
        pointSpec = self.mpDraw.DrawingSpec(color=(255, 255, 0), circle_radius=1)
        lineSpec = self.mpDraw.DrawingSpec(color=(255, 255, 255), thickness=1)
        imgRGB = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        self.result = self.face.process(imgRGB)
        if self.result.multi_face_landmarks:
            for faceLms in self.result.multi_face_landmarks:
                if draw:
                    self.mpDraw.draw_landmarks(img, faceLms, self.mpFace.FACEMESH_CONTOURS, pointSpec, lineSpec)

        return img

    def findPositon(self, img, draw=False, nose=False):
        pointSpec = self.mpDraw.DrawingSpec(color=(255, 255, 0), circle_radius=1)
        lineSpec = self.mpDraw.DrawingSpec(color=(255, 255, 255), thickness=1)
        points = []
        imgRGB = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        self.result = self.face.process(imgRGB)
        if self.result.multi_face_landmarks:
            for faceLms in self.result.multi_face_landmarks:
                for id, lm in enumerate(faceLms.landmark):
                    h, w = img.shape[:2]
                    cx, cy = int(lm.x * w), int(lm.y * h)
                    points.append([id, cx, cy])
                    # cv2.putText(img, str(id), (cx, cy), cv2.FONT_HERSHEY_PLAIN, 0.3, (255, 255, 0), 1)
                    if nose and id == 1:
                        cv2.circle(img, (cx, cy), 5, (255, 255, 0), 1)
                if draw:
                    self.mpDraw.draw_landmarks(img, faceLms, self.mpFace.FACEMESH_CONTOURS, pointSpec, lineSpec)

        if nose:
            return points[1], img
        return points, img


    #game function





#
# def main():
#     cap = cv2.VideoCapture(0)
#     detector = FaceDetector()
#     while True:
#         success, img = cap.read()
#         img = cv2.flip(img, 1)
#         # img = detector.findFace(img)
#
#         landmarks = detector.findPositon(img, True)
#         print(landmarks)
#
#         cv2.imshow('image', img)
#         cv2.waitKey(1)
#
# if __name__ == "__main__":
#     main()