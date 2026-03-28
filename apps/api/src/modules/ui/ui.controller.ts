import { Controller, Get } from '@nestjs/common';
import { UiService } from './ui.service';
import { DashboardResponseDto } from './dto/dashboard-response.dto';

@Controller({
  path: 'ui',
  version: '1',
})
export class UiController {
  constructor(private readonly uiService: UiService) {}

  @Get('dashboard')
  async getDashboard(): Promise<DashboardResponseDto> {
    return this.uiService.getDashboard();
  }

  @Get('scene')
  async getScene() {
    return this.uiService.getScene();
  }
}
