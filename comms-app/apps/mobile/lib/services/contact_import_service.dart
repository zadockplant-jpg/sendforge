import '../models/contact.dart';

class ContactImportService {
  static List<Contact> mock() {
    return [
      Contact(id: "1", name: "Alice", phone: "+15551234567"),
      Contact(id: "2", name: "Bob", email: "bob@test.com"),
    ];
  }
}
