import 'dart:convert';
import 'dart:io';

import 'package:file_picker/file_picker.dart';
import '../models/contact.dart';

class CsvParser {
  static Future<List<Contact>> pickAndParseCsv() async {
    final result = await FilePicker.platform.pickFiles(
      type: FileType.custom,
      allowedExtensions: ['csv'],
      withData: true,
    );

    if (result == null || result.files.isEmpty) {
      return [];
    }

    final file = result.files.first;
    final bytes = file.bytes ?? await File(file.path!).readAsBytes();
    final content = utf8.decode(bytes);

    return _parse(content);
  }

  static List<Contact> _parse(String csv) {
    final lines = const LineSplitter().convert(csv);
    if (lines.isEmpty) return [];

    final headers = lines.first
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .toList();

    int nameIdx = headers.indexOf('name');
    int phoneIdx = headers.indexOf('phone');
    int emailIdx = headers.indexOf('email');

    if (nameIdx == -1 && phoneIdx == -1 && emailIdx == -1) {
      throw Exception('CSV must contain at least one of: name, phone, email');
    }

    final contacts = <Contact>[];

    for (int i = 1; i < lines.length; i++) {
      final cols = lines[i].split(',');
      if (cols.isEmpty) continue;

      final name =
          nameIdx >= 0 && nameIdx < cols.length ? cols[nameIdx].trim() : '';
      final phone =
          phoneIdx >= 0 && phoneIdx < cols.length ? cols[phoneIdx].trim() : null;
      final email =
          emailIdx >= 0 && emailIdx < cols.length ? cols[emailIdx].trim() : null;

      if (name.isEmpty && (phone == null || phone.isEmpty) && (email == null || email.isEmpty)) {
        continue;
      }

      contacts.add(
        Contact(
          id: 'csv-$i',
          name: name.isNotEmpty ? name : 'Unknown',
          phone: phone,
          email: email,
        ),
      );
    }

    return contacts;
  }
}
