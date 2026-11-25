// The words photo keywords are chosen from (the keywords model scores a photo against each). Everyday
// things, places, scenes and occasions people search family and travel photos for. Lower case, unique.
// Changing the list changes the keywords of photos tagged afterwards only.

const GROUPS: string[] = [
  // People and occasions
  'person', 'people', 'man', 'woman', 'child', 'baby', 'toddler', 'boy', 'girl', 'teenager', 'family', 'couple',
  'friends', 'crowd', 'group photo', 'portrait', 'selfie', 'grandparent', 'bride', 'groom', 'wedding', 'birthday',
  'birthday cake', 'party', 'graduation', 'christmas', 'christmas tree', 'halloween', 'easter', 'new year',
  'fireworks', 'concert', 'festival', 'parade', 'ceremony', 'picnic', 'barbecue', 'camping', 'hiking', 'holiday',
  'vacation', 'road trip', 'reunion', 'dinner party', 'baby shower', 'funeral', 'school', 'classroom', 'sports day',
  'dancing', 'singing', 'playing', 'laughing', 'smiling', 'hugging', 'sleeping', 'eating', 'cooking', 'reading',
  'swimming', 'running', 'cycling', 'skiing', 'snowboarding', 'surfing', 'sailing', 'fishing', 'climbing',
  'skating', 'gardening', 'painting', 'drawing', 'shopping', 'working', 'studying', 'gaming',
  // Animals
  'dog', 'puppy', 'cat', 'kitten', 'bird', 'parrot', 'duck', 'goose', 'swan', 'chicken', 'horse', 'pony', 'cow',
  'sheep', 'goat', 'pig', 'rabbit', 'hamster', 'fish', 'goldfish', 'turtle', 'frog', 'snake', 'lizard', 'butterfly',
  'bee', 'spider', 'insect', 'squirrel', 'deer', 'fox', 'bear', 'wolf', 'lion', 'tiger', 'elephant', 'giraffe',
  'zebra', 'monkey', 'gorilla', 'kangaroo', 'koala', 'panda', 'penguin', 'seal', 'dolphin', 'whale', 'shark',
  'crab', 'jellyfish', 'owl', 'eagle', 'pigeon', 'seagull', 'flamingo', 'peacock', 'camel', 'donkey', 'zoo',
  'aquarium', 'farm animals', 'pet',
  // Nature and landscape
  'landscape', 'nature', 'mountain', 'hill', 'valley', 'cliff', 'canyon', 'volcano', 'glacier', 'cave', 'rock',
  'desert', 'sand dune', 'forest', 'jungle', 'woods', 'tree', 'palm tree', 'pine tree', 'autumn leaves', 'leaf',
  'flower', 'rose', 'tulip', 'sunflower', 'daisy', 'cherry blossom', 'lavender', 'garden', 'lawn', 'grass',
  'meadow', 'field', 'wheat field', 'vineyard', 'orchard', 'farm', 'countryside', 'river', 'stream', 'waterfall',
  'lake', 'pond', 'sea', 'ocean', 'beach', 'coast', 'bay', 'island', 'wave', 'harbour', 'pier', 'lighthouse',
  'sand', 'shell', 'coral reef', 'underwater', 'sky', 'cloud', 'blue sky', 'sunset', 'sunrise', 'dusk',
  'night sky', 'stars', 'moon', 'rainbow', 'storm', 'lightning', 'fog', 'mist', 'rain', 'snow', 'ice', 'frost',
  'winter', 'spring', 'summer', 'autumn', 'park', 'national park', 'trail', 'path', 'mountain view', 'scenery',
  // Places and buildings
  'city', 'town', 'village', 'street', 'alley', 'road', 'highway', 'bridge', 'tunnel', 'skyline', 'skyscraper',
  'building', 'house', 'cottage', 'cabin', 'apartment', 'castle', 'palace', 'tower', 'church', 'cathedral',
  'mosque', 'temple', 'shrine', 'monument', 'statue', 'fountain', 'ruins', 'museum', 'art gallery', 'library',
  'market', 'shop', 'supermarket', 'mall', 'restaurant', 'cafe', 'bar', 'pub', 'bakery', 'hotel', 'hotel room',
  'pool', 'swimming pool', 'gym', 'stadium', 'playground', 'amusement park', 'roller coaster', 'ferris wheel',
  'theatre', 'cinema', 'airport', 'train station', 'bus stop', 'port', 'marina', 'parking lot', 'gas station',
  'hospital', 'office', 'factory', 'warehouse', 'construction site', 'square', 'plaza', 'old town', 'harbour town',
  'graffiti', 'mural', 'neon sign', 'street sign', 'shop window', 'balcony', 'rooftop', 'courtyard', 'staircase',
  'doorway', 'window', 'fence', 'wall', 'gate', 'garden path', 'backyard', 'patio', 'porch', 'driveway',
  // Indoors and home
  'room', 'living room', 'kitchen', 'bedroom', 'bathroom', 'dining room', 'hallway', 'garage', 'attic', 'basement',
  'sofa', 'chair', 'table', 'bed', 'desk', 'shelf', 'bookshelf', 'fireplace', 'lamp', 'candle', 'mirror', 'clock',
  'carpet', 'curtain', 'pillow', 'blanket', 'plant', 'houseplant', 'vase', 'painting on wall', 'photo frame',
  'television', 'computer', 'laptop', 'phone', 'camera', 'headphones', 'keyboard', 'piano', 'guitar', 'violin',
  'drum', 'book', 'magazine', 'newspaper', 'letter', 'map', 'toy', 'teddy bear', 'doll', 'lego', 'board game',
  'puzzle', 'balloon', 'gift', 'present', 'wrapping paper', 'decoration', 'christmas lights', 'umbrella', 'bag',
  'backpack', 'suitcase', 'luggage', 'hat', 'sunglasses', 'glasses', 'shoes', 'boots', 'dress', 'suit', 'jacket',
  'coat', 'scarf', 'costume', 'uniform', 'jewellery', 'watch', 'ring', 'flowers in vase', 'bouquet',
  // Food and drink
  'food', 'meal', 'breakfast', 'lunch', 'dinner', 'dessert', 'snack', 'cake', 'cupcake', 'cookie', 'bread',
  'sandwich', 'burger', 'pizza', 'pasta', 'noodles', 'rice', 'sushi', 'salad', 'soup', 'steak', 'chicken dish',
  'seafood', 'fish dish', 'fruit', 'apple', 'banana', 'orange', 'strawberry', 'grapes', 'watermelon', 'lemon',
  'vegetables', 'tomato', 'carrot', 'potato', 'cheese', 'eggs', 'chocolate', 'ice cream', 'candy', 'pie',
  'pancakes', 'coffee', 'tea', 'cup', 'mug', 'wine', 'beer', 'cocktail', 'juice', 'water bottle', 'glass',
  'plate', 'bowl', 'cutlery', 'picnic blanket', 'street food', 'food market', 'buffet', 'kitchen table',
  // Vehicles and transport
  'car', 'vintage car', 'truck', 'van', 'bus', 'train', 'tram', 'subway', 'motorcycle', 'scooter', 'bicycle',
  'boat', 'sailboat', 'ship', 'cruise ship', 'ferry', 'canoe', 'kayak', 'yacht', 'airplane', 'helicopter',
  'hot air balloon', 'tractor', 'taxi', 'police car', 'fire truck', 'ambulance', 'skateboard', 'stroller',
  'wheelchair', 'horse and cart',
  // Sport and play
  'football', 'soccer', 'basketball', 'tennis', 'golf', 'baseball', 'cricket', 'rugby', 'hockey', 'volleyball',
  'boxing', 'yoga', 'martial arts', 'horse riding', 'race', 'marathon', 'swimming race', 'trophy', 'medal',
  'ball', 'kite', 'swing', 'slide', 'sandcastle', 'snowman', 'sledding', 'water park', 'trampoline',
  // Photo kinds and look
  'close-up', 'macro', 'aerial view', 'panorama', 'black and white photo', 'old photo', 'scanned photo',
  'blurry photo', 'dark photo', 'bright photo', 'silhouette', 'reflection', 'shadow', 'long exposure', 'bokeh',
  'night photo', 'indoor photo', 'outdoor photo', 'screenshot', 'document', 'receipt', 'text', 'sign', 'poster',
  'drawing', 'illustration', 'cartoon', 'abstract pattern', 'texture', 'colourful', 'pastel colours',
  'gradient', 'minimalist', 'symmetry', 'crowded', 'empty', 'quiet', 'cozy', 'romantic', 'happy', 'funny',
  // Colours
  'red', 'orange colour', 'yellow', 'green', 'blue', 'purple', 'pink', 'brown', 'black', 'white', 'grey', 'gold',
  'silver',
];

export const VOCABULARY: readonly string[] = [...new Set(GROUPS)];
