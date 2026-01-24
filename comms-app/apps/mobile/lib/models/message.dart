class Message {
  final String id;
  final String sender;
  final String body;
  final bool incoming;
  final DateTime timestamp;

  Message({
    required this.id,
    required this.sender,
    required this.body,
    required this.incoming,
    required this.timestamp,
  });
}
