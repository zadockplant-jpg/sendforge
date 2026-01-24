enum BlastChannel { sms, email }

class BlastDraft {
  Set<BlastChannel> channels = {};
  List<String> groupIds = [];
  String body = "";
  String subject = "";
}
