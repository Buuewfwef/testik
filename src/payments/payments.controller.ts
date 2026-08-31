import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { IsIn, IsInt, IsString, Min } from 'class-validator';
import { PaymentsService } from './payments.service';

class PaymentWebhookDto {
  @IsString()
  event_id!: string;

  @IsString()
  order_id!: string;

  @IsIn(['paid', 'failed'])
  status!: 'paid' | 'failed';

  @IsInt()
  @Min(0)
  amount!: number;

  @IsString()
  currency!: string;

  @IsString()
  created_at!: string;
}

@Controller('webhook')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('payment')
  @HttpCode(200)
  handle(@Body() body: PaymentWebhookDto) {
    return this.payments.handleWebhook(body);
  }
}
