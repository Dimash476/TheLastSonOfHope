# The Last son of Hope

Мини проект, для практики применения прикладного компьютерного зрения.
Игра - написанна на Three.js с использованием Claude Code, Модуль управления через камеру с исользованием MediaPipe написан в ручную автором. 

# Краткое описание

3D - симулятор вдохновленный экранизацией Man of Steel / The last son of Crypton. (Фан-проект, не связан с DC Comics и Warner Bros.)

В игре присутсвует три основных режима:

- **Симулятор** — свободная игра без правил и заданий.
- **Битва** — бой с Колоссом, каменным великаном с магмой внутри.
- **Сюжет** — в разработке.

# Управление
- **Клавиатура и мышь** - базовое управление через ПК. Инструкции по управлению встроенны в игру.
- **Камера** - перенос управления через камеру. Нажать CTRL, подождать завершения калибровки. 

# Карта жестов
- **Повороты** - движение головой (программа следит за точкой на конце носа), тоже самое что и WASD на пк.
- **Активация полета/ускорение** - Появление левой руки в кадре - включает полет, при сжатии левой руки активируется ускорение.
- **Дополнительное ускорение** - Разведение и сведение указательного и большого пальец правой руки, ускоряют полет.


## Запуск

Нужны Python 3 и интернет (движок three.js загружается с CDN).

```bash
python server.py 8000
```

Затем открыть http://localhost:8000. На Windows можно просто дважды кликнуть `start.bat`.

Первые 5 секунд после включения — калибровка: смотрите прямо в экран.

Нужен Python 3.12 (у mediapipe 0.10.21 нет сборок под более новые версии):

```bash
cd GameTracking
py -3.12 -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
```

Другой Python можно указать в переменной окружения `TRACKING_PYTHON`.

Модуль распознавания жестов (`GameTracking/`) написан автором вручную; связь с игрой и небольшие доработки — с помощью Claude Code.

## Кастомизация (своя музыка)

По желанию. Аудиофайлы в репозиторий не попадают.

- `music/` — mp3, ogg или m4a: играют по очереди, `M` — следующий трек.
- `music/party/` — трек для вечеринки на острове (mp3, ogg, m4a, wav, webm, opus): громче всего у сцены, вне острова — пауза.
- `assets/audio/city_ambience.mp3` (или `.ogg`) — запись городского фона вместо синтезированного. Только с лицензией CC0.

Без этих файлов все звуки и музыка синтезируются кодом игры.

## Сторонние компоненты

| Компонент | Автор | Лицензия | Как используется |
|---|---|---|---|
| [three.js](https://threejs.org) r160 | three.js authors | [MIT](https://github.com/mrdoob/three.js/blob/r160/LICENSE) | Загружается браузером с CDN [jsDelivr](https://www.jsdelivr.com), в репозитории не хранится |
| 3D-модель «Free Rigged Male Basemesh» | Filip ([Sketchfab](https://sketchfab.com/filip.hans.nyberg)) | [CC-BY-4.0](http://creativecommons.org/licenses/by/4.0/) | `assets/models/hero/` вместе с `license.txt` |
| [MediaPipe](https://github.com/google-ai-edge/mediapipe) 0.10.21 | Google | [Apache-2.0](https://github.com/google-ai-edge/mediapipe/blob/master/LICENSE) | Распознавание лица и рук; ставится через pip |
| [OpenCV](https://opencv.org) | OpenCV team | [Apache-2.0](https://github.com/opencv/opencv/blob/4.x/LICENSE) | Работа с камерой; ставится вместе с MediaPipe |
| [websockets](https://github.com/python-websockets/websockets) | Aymeric Augustin and contributors | [BSD-3-Clause](https://github.com/python-websockets/websockets/blob/main/LICENSE) | Связь скрипта с игрой; ставится через pip |

Модель персонажа: This work is based on "Free Rigged Male Basemesh" (https://sketchfab.com/3d-models/free-rigged-male-basemesh-b8de3373addd4decac40400ee96c62e0) by Filip (https://sketchfab.com/filip.hans.nyberg) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/).
Изменения: добавлены костюм (шейдер), плащ и процедурные анимации; исходная геометрия не менялась.

## Права

© 2026 DimashSh2407. Все права защищены.

Исходный код открыт для просмотра, но **не распространяется под открытой лицензией**: копирование, изменение и использование кода
в других проектах — только с разрешения автора. Сторонние компоненты (см. таблицу выше) используются на условиях своих лицензий.
