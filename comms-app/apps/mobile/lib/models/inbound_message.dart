class InboundMessage {
  final String id;
  final String groupId;
  final String sender;
  final String body;
  final DateTime timestamp;

  InboundMessage({
    required this.id,
    required this.groupId,
    required this.sender,
    required this.body,
    required this.timestamp,
  });
}
